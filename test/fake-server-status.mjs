// The same fake server, started through a file that names clarion/diagnosticsStatus, so the client's
// static probe (LspClient.start) marks the server status-capable before its first publish; the
// literal is kept out of fake-server.mjs so the other runs count publishes.
import "./fake-server.mjs";
