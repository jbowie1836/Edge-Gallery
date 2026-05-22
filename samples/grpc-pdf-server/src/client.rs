//! Test client for `grpc-pdf-server`.
//!
//! Invokes `ListAvailable` to discover what the server is willing
//! to serve, then drives `GetPdfStream` for one (or every) DCN and
//! reports chunk counts plus total bytes. Optional `--out` writes
//! the reassembled PDF to disk so the operator can validate it
//! opens cleanly.

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use tokio_stream::StreamExt;

pub mod pdf_proto {
    tonic::include_proto!("ecm.pdf.v1");
}

use pdf_proto::pdf_service_client::PdfServiceClient;
use pdf_proto::{GetPdfRequest, ListAvailableRequest};

#[derive(Parser, Debug)]
#[command(name = "grpc-pdf-client", version, about = "Test client for grpc-pdf-server")]
struct Cli {
    /// gRPC server endpoint, e.g. http://127.0.0.1:50051.
    #[arg(long, default_value = "http://127.0.0.1:50051")]
    endpoint: String,

    /// DCN to stream. Empty triggers the server's round-robin pick.
    #[arg(long, default_value = "")]
    dcn: String,

    /// Stream every DCN listed by ListAvailable in sequence.
    #[arg(long)]
    all: bool,

    /// Chunk size to request; 0 leaves it server-default.
    #[arg(long, default_value_t = 0)]
    chunk: u32,

    /// Write the reassembled PDF to this path. Skipped when --all.
    #[arg(long)]
    out: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let mut client = PdfServiceClient::connect(cli.endpoint.clone())
        .await
        .with_context(|| format!("connecting to {}", cli.endpoint))?;

    let listed = client
        .list_available(ListAvailableRequest {})
        .await
        .context("list_available")?
        .into_inner();
    println!("[grpc-pdf-client] server has {} PDFs:", listed.pdfs.len());
    for p in &listed.pdfs {
        println!("  - {} ({} bytes)", p.dcn, p.size_bytes);
    }

    if cli.all {
        for p in listed.pdfs.iter() {
            stream_one(&mut client, &p.dcn, cli.chunk, None).await?;
        }
    } else {
        stream_one(&mut client, &cli.dcn, cli.chunk, cli.out.as_deref()).await?;
    }
    Ok(())
}

async fn stream_one(
    client: &mut PdfServiceClient<tonic::transport::Channel>,
    dcn: &str,
    chunk: u32,
    out: Option<&std::path::Path>,
) -> Result<()> {
    let req = GetPdfRequest {
        dcn: dcn.to_string(),
        chunk_size: chunk,
    };
    let start = std::time::Instant::now();
    let mut stream = client
        .get_pdf_stream(req)
        .await
        .with_context(|| format!("starting stream for '{dcn}'"))?
        .into_inner();
    let mut chunks: u64 = 0;
    let mut bytes: u64 = 0;
    let mut sink: Vec<u8> = Vec::new();
    let mut last_dcn = String::new();
    while let Some(item) = stream.next().await {
        let c = item.context("stream item")?;
        chunks += 1;
        bytes += c.data.len() as u64;
        last_dcn = c.dcn.clone();
        if out.is_some() {
            sink.extend_from_slice(&c.data);
        }
        if c.is_final {
            break;
        }
    }
    let elapsed = start.elapsed();
    println!(
        "[grpc-pdf-client] streamed DCN={} chunks={} bytes={} in {}ms",
        last_dcn,
        chunks,
        bytes,
        elapsed.as_millis()
    );
    if let Some(p) = out {
        std::fs::write(p, &sink).with_context(|| format!("writing {}", p.display()))?;
        println!("[grpc-pdf-client] wrote reassembled PDF to {}", p.display());
        // Sanity-check the PDF magic so we know the stream
        // reassembled cleanly.
        if !sink.starts_with(b"%PDF-") {
            eprintln!("[grpc-pdf-client] WARN: reassembled bytes do not start with %PDF-");
        }
    }
    Ok(())
}
