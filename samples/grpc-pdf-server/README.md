# grpc-pdf-server

Sample gRPC service that streams PDF bytes from a folder. Companion
test target for `ecm-loadtest`.

## What it does

- Reads every `.pdf` file from a configurable folder at startup
- Indexes each file by its filename stem as a DCN
- Exposes two RPCs:
  - `GetPdfStream(GetPdfRequest) returns (stream PdfChunk)` --
    server-streaming RPC that returns the PDF bytes in
    client-controlled chunks
  - `ListAvailable(ListAvailableRequest) returns (ListAvailableResponse)` --
    informational, returns the set of DCNs the server can serve

## Layout

```
samples/grpc-pdf-server/
  Cargo.toml                 (standalone crate; not in the workspace)
  build.rs                   (tonic-build compiles the .proto at build time)
  proto/pdf.proto            (service definition)
  pdfs/                      (PDF fixtures the server serves)
  src/
    server.rs                ([[bin]] grpc-pdf-server)
    client.rs                ([[bin]] grpc-pdf-client; test driver)
```

## Build

```
cd samples/grpc-pdf-server
cargo build --release
```

Requires `protoc` (the protobuf compiler) on PATH. On Debian /
Ubuntu: `apt-get install -y protobuf-compiler`. On macOS:
`brew install protobuf`. On Windows: chocolatey, scoop, or
the official release zip.

## Run the server

```
./target/release/grpc-pdf-server \
    --pdf-dir samples/grpc-pdf-server/pdfs \
    --listen 127.0.0.1:50051 \
    --default-chunk 65536
```

The server logs each PDF it loaded and the listen address. The
listen address can be `0.0.0.0:50051` for "all interfaces" if the
server needs to be reachable from another host.

## Drive the test client

```
# stream one DCN, write the reassembled PDF to disk
./target/release/grpc-pdf-client \
    --endpoint http://127.0.0.1:50051 \
    --dcn DCN0000000002 \
    --out /tmp/out.pdf

# stream every DCN the server lists, at a smaller chunk size
./target/release/grpc-pdf-client --all --chunk 4096
```

Expected output for the single-DCN case:

```
[grpc-pdf-client] server has 3 PDFs:
  - DCN0000000001 (352 bytes)
  - DCN0000000002 (352 bytes)
  - DCN0000000003 (352 bytes)
[grpc-pdf-client] streamed DCN=DCN0000000002 chunks=1 bytes=352 in 1ms
[grpc-pdf-client] wrote reassembled PDF to /tmp/out.pdf
```

The client checks the `%PDF-` magic on the reassembled bytes and
prints a WARN if the prefix is wrong.

## Wire format

`PdfChunk` carries:

```
dcn          string   echoed on every chunk so multiplexed streams can demux
seq          uint64   0-indexed sequence number
data         bytes    raw PDF bytes for this chunk
is_final     bool     true on the last chunk for this DCN
total_bytes  uint64   populated on the final chunk only
```

Chunk size is clamped server-side to `[1024, 1048576]` bytes. Asking
for 64-byte chunks gets you 1024-byte chunks; asking for 0 gets you
the server's `--default-chunk`.

## Using grpcurl directly

```
grpcurl -plaintext -import-path proto -proto pdf.proto \
    127.0.0.1:50051 ecm.pdf.v1.PdfService/ListAvailable

grpcurl -plaintext -import-path proto -proto pdf.proto \
    -d '{"dcn":"DCN0000000001","chunk_size":4096}' \
    127.0.0.1:50051 ecm.pdf.v1.PdfService/GetPdfStream
```

## Fixtures

The `pdfs/` folder ships with three 352-byte minimal valid PDFs
(`DCN0000000001.pdf` through `DCN0000000003.pdf`) so the server has
something to serve out-of-the-box. Drop any additional `.pdf` files
into that folder and restart the server to expand the catalog.

## Not in scope

- TLS / mTLS (server is plaintext h2 only; that's appropriate for
  a local test target)
- Authentication (none; the service is for test runs on loopback)
- Connection-level load shedding (every connect is accepted)
- Per-DCN access control (every loaded PDF is publicly addressable)
