//! Sample gRPC server that streams PDF bytes from a folder.
//!
//! Designed as a test target: stand it up, point a gRPC client (or
//! the bundled grpc-pdf-client binary) at it, and observe the
//! `GetPdfStream` server-streaming RPC behavior. The PDFs come
//! from a folder configured at startup; every file matching
//! `<folder>/*.pdf` becomes addressable by its filename stem as a
//! DCN.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{transport::Server, Request, Response, Status};

// Pull in the generated protobuf types. tonic-build emits this
// module at OUT_DIR; the include macro splices it in here.
pub mod pdf_proto {
    tonic::include_proto!("ecm.pdf.v1");
}

use pdf_proto::pdf_service_server::{PdfService, PdfServiceServer};
use pdf_proto::{
    GetPdfRequest, ListAvailableRequest, ListAvailableResponse, PdfChunk, PdfDescriptor,
};

// ============================================================
// CLI
// ============================================================

#[derive(Parser, Debug)]
#[command(name = "grpc-pdf-server", version, about = "Sample gRPC PDF streaming service")]
struct Cli {
    /// Path to the folder containing .pdf files. Every PDF in this
    /// folder becomes addressable by its filename stem.
    #[arg(long, default_value = "pdfs")]
    pdf_dir: PathBuf,

    /// TCP address to bind. Use 0.0.0.0 for "all interfaces" or
    /// 127.0.0.1 to restrict to loopback.
    #[arg(long, default_value = "127.0.0.1:50051")]
    listen: String,

    /// Default chunk size in bytes when the client does not request
    /// a specific size. Clamped to [1024, 1048576].
    #[arg(long, default_value_t = 65536)]
    default_chunk: u32,
}

// ============================================================
// Service implementation
// ============================================================

/// Snapshot of what the server is willing to serve, loaded once
/// at startup. Storing the PDF bytes in memory keeps the streaming
/// hot-path lock-free; for very large catalogs you would want
/// lazy filesystem reads instead.
#[derive(Debug, Clone)]
struct PdfCatalog {
    /// dcn -> raw bytes
    pdfs: Arc<HashMap<String, Vec<u8>>>,
    /// Ordering used for round-robin "pick one" requests.
    dcn_order: Arc<Vec<String>>,
}

impl PdfCatalog {
    fn load(dir: &Path) -> Result<Self> {
        if !dir.exists() {
            anyhow::bail!("pdf_dir does not exist: {}", dir.display());
        }
        let mut pdfs: HashMap<String, Vec<u8>> = HashMap::new();
        let mut dcn_order = Vec::new();
        for entry in std::fs::read_dir(dir)
            .with_context(|| format!("reading {}", dir.display()))?
            .flatten()
        {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            // We accept .pdf files; the file stem becomes the DCN.
            let is_pdf = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false);
            if !is_pdf {
                continue;
            }
            let dcn = p
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "unknown".into());
            let bytes = std::fs::read(&p)
                .with_context(|| format!("reading {}", p.display()))?;
            eprintln!(
                "[grpc-pdf-server] loaded {} ({} bytes) as DCN={}",
                p.display(),
                bytes.len(),
                dcn
            );
            pdfs.insert(dcn.clone(), bytes);
            dcn_order.push(dcn);
        }
        if pdfs.is_empty() {
            anyhow::bail!(
                "no .pdf files found in {}; populate it before starting the server",
                dir.display()
            );
        }
        dcn_order.sort();
        Ok(Self {
            pdfs: Arc::new(pdfs),
            dcn_order: Arc::new(dcn_order),
        })
    }
}

#[derive(Debug)]
struct PdfServiceImpl {
    catalog: PdfCatalog,
    default_chunk: u32,
    /// Round-robin cursor used for "pick one" requests. Atomic so
    /// concurrent calls share the same rotation.
    rr_cursor: Arc<std::sync::atomic::AtomicUsize>,
}

#[tonic::async_trait]
impl PdfService for PdfServiceImpl {
    /// The stream type is what tonic emits in the generated trait;
    /// we wrap an mpsc receiver in `ReceiverStream` so we can
    /// produce chunks from a spawned task without sharing the
    /// service struct across awaits.
    type GetPdfStreamStream = ReceiverStream<Result<PdfChunk, Status>>;

    async fn get_pdf_stream(
        &self,
        req: Request<GetPdfRequest>,
    ) -> Result<Response<Self::GetPdfStreamStream>, Status> {
        let req = req.into_inner();
        // Resolve which DCN to serve. Empty string means "pick the
        // next one in round-robin order" -- convenient for soak
        // tests that just want sustained load.
        let dcn = if req.dcn.is_empty() {
            let cursor = self
                .rr_cursor
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.catalog
                .dcn_order
                .get(cursor % self.catalog.dcn_order.len())
                .cloned()
                .unwrap_or_default()
        } else {
            req.dcn.clone()
        };

        let bytes = self
            .catalog
            .pdfs
            .get(&dcn)
            .cloned()
            .ok_or_else(|| Status::not_found(format!("DCN '{dcn}' not found in catalog")))?;

        // Clamp the chunk size to a sensible window. A pathological
        // 1-byte chunk_size would multiply the message overhead by
        // four orders of magnitude.
        let chunk_size = match req.chunk_size {
            0 => self.default_chunk as usize,
            n => (n as usize).clamp(1024, 1024 * 1024),
        };

        // The receiver side of this channel becomes the response
        // stream. We use bounded(8) so a slow client back-pressures
        // the producer instead of buffering the whole PDF in RAM
        // again.
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<PdfChunk, Status>>(8);
        let total_bytes = bytes.len() as u64;
        tokio::spawn(async move {
            let mut seq: u64 = 0;
            let mut offset = 0usize;
            while offset < bytes.len() {
                let end = (offset + chunk_size).min(bytes.len());
                let is_final = end == bytes.len();
                let chunk = PdfChunk {
                    dcn: dcn.clone(),
                    seq,
                    data: bytes[offset..end].to_vec(),
                    is_final,
                    total_bytes: if is_final { total_bytes } else { 0 },
                };
                if tx.send(Ok(chunk)).await.is_err() {
                    // Client hung up; stop streaming.
                    break;
                }
                seq += 1;
                offset = end;
            }
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }

    async fn list_available(
        &self,
        _req: Request<ListAvailableRequest>,
    ) -> Result<Response<ListAvailableResponse>, Status> {
        let pdfs = self
            .catalog
            .dcn_order
            .iter()
            .map(|dcn| PdfDescriptor {
                dcn: dcn.clone(),
                size_bytes: self
                    .catalog
                    .pdfs
                    .get(dcn)
                    .map(|v| v.len() as u64)
                    .unwrap_or(0),
            })
            .collect();
        Ok(Response::new(ListAvailableResponse { pdfs }))
    }
}

// ============================================================
// Entry point
// ============================================================

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let catalog = PdfCatalog::load(&cli.pdf_dir)?;
    eprintln!(
        "[grpc-pdf-server] serving {} PDFs from {} on grpc://{}",
        catalog.pdfs.len(),
        cli.pdf_dir.display(),
        cli.listen
    );
    let addr: std::net::SocketAddr = cli
        .listen
        .parse()
        .with_context(|| format!("parsing listen address '{}'", cli.listen))?;

    let svc = PdfServiceImpl {
        catalog,
        default_chunk: cli.default_chunk,
        rr_cursor: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    };

    Server::builder()
        .add_service(PdfServiceServer::new(svc))
        .serve(addr)
        .await
        .context("gRPC server terminated")?;
    Ok(())
}
