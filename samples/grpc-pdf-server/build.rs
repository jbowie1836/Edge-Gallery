//! Compile the .proto file into Rust at build time.
//!
//! tonic-build invokes protoc, generating
//! `OUT_DIR/ecm.pdf.v1.rs` which `src/server.rs` and
//! `src/client.rs` pull in via `tonic::include_proto!`.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(&["proto/pdf.proto"], &["proto"])?;
    println!("cargo:rerun-if-changed=proto/pdf.proto");
    Ok(())
}
