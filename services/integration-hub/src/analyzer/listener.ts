/**
 * The socket. Everything else in `analyzer/` is transport-free on purpose, and
 * this file is the reason that was worth doing: it is small enough to read in
 * one sitting, and it contains no protocol logic at all.
 *
 * `EN-004 §3.1.4` asks for "listener/connector process … per instrument worker"
 * with "auto-reconnect with backoff", and `EN-004 §13` for "per-instrument
 * isolation (one bad feed cannot block others)". Both are properties of this
 * layer: one server per instrument, one session per socket, and an error on one
 * socket that closes that socket and nothing else.
 *
 * The one thing this file must never do is write a reply that the session did
 * not produce. Every byte written back comes from `session.receive()`, which
 * cannot produce an acknowledgement without having awaited a commit.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { AdapterLogger } from '../adapter/types.js';
import type { AnalyzerSession } from './session.js';
import type { AnalyzerInstrument } from './types.js';

export interface AnalyzerListenerDeps {
  readonly logger: AdapterLogger;
  /** A fresh session per connection: framing state must not survive a reconnect. */
  readonly sessionFor: (instrument: AnalyzerInstrument) => AnalyzerSession;
  /** Called when a connection opens and closes, for the downtime log. */
  readonly onConnect?: (instrument: AnalyzerInstrument) => void;
  readonly onDisconnect?: (instrument: AnalyzerInstrument, reason: string) => void;
}

export class AnalyzerListener {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(
    readonly instrument: AnalyzerInstrument,
    private readonly deps: AnalyzerListenerDeps,
  ) {}

  /** Binds and returns the port actually listening (0 asks the OS to choose). */
  async listen(port?: number, host = '127.0.0.1'): Promise<number> {
    const requested = port ?? this.instrument.connection.port ?? 0;
    const server = createServer((socket) => {
      this.accept(socket);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(requested, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : requested;
    this.deps.logger.info(
      { instrumentId: this.instrument.id, instrumentCode: this.instrument.code, port: bound },
      'analyzer listener bound',
    );
    return bound;
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    const session = this.deps.sessionFor(this.instrument);
    this.deps.onConnect?.(this.instrument);

    // Backpressure: one frame is processed at a time. An analyzer that bursts
    // 200 results a minute must not have frame 7 answered before frame 3.
    let chain: Promise<void> = Promise.resolve();

    socket.on('data', (chunk: Buffer) => {
      chain = chain.then(async () => {
        try {
          const reply = await session.receive(chunk);
          if (reply.length > 0 && !socket.destroyed) socket.write(reply);
        } catch (error) {
          // `docs/04` §7: never swallow. The socket is closed *without* an
          // acknowledgement, so the analyzer keeps its results and resends.
          this.deps.logger.error(
            {
              instrumentId: this.instrument.id,
              error: error instanceof Error ? error.name : 'unknown',
            },
            'analyzer session failed; the connection was closed without acknowledging',
          );
          socket.destroy();
        }
      });
    });

    socket.on('error', (error: Error) => {
      this.deps.logger.warn({ instrumentId: this.instrument.id, error: error.name }, 'analyzer socket error');
    });

    socket.on('close', () => {
      this.sockets.delete(socket);
      session.reset();
      this.deps.onDisconnect?.(this.instrument, 'the analyzer closed the connection');
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
