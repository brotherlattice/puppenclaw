import type { PluginLogger } from "openclaw/plugin-sdk/core";

import { ensureError } from "../shared/errors.js";

export type OutputRouteEvent =
  | {
      kind: "chunk";
      sessionName: string;
      text: string;
    }
  | {
      kind: "complete";
      sessionName: string;
      text: string;
    }
  | {
      kind: "error";
      sessionName: string;
      text: string;
    }
  | {
      kind: "question";
      sessionName: string;
      text: string;
    };

export type OutputDispatcher = (event: OutputRouteEvent) => Promise<void> | void;

type SessionBuffer = {
  pending: string;
};

export class OutputRouter {
  private readonly buffers = new Map<string, SessionBuffer>();

  private readonly dispatchers = new Map<string, OutputDispatcher>();

  constructor(
    private readonly logger: PluginLogger,
    private readonly options: {
      flushThreshold?: number;
    } = {}
  ) {}

  attach(sessionName: string, dispatcher: OutputDispatcher): void {
    this.dispatchers.set(sessionName, dispatcher);
  }

  detach(sessionName: string): void {
    this.dispatchers.delete(sessionName);
  }

  async onChunk(sessionName: string, chunk: string): Promise<void> {
    if (!chunk) {
      return;
    }
    const buffer = this.ensureBuffer(sessionName);
    buffer.pending += chunk;
    await this.flushBufferedChunks(sessionName, false);
  }

  async onComplete(sessionName: string, summary: string): Promise<void> {
    await this.flushBufferedChunks(sessionName, true);
    if (!summary.trim()) {
      return;
    }
    await this.dispatch(sessionName, {
      kind: "complete",
      sessionName,
      text: summary.trim()
    });
  }

  async onError(sessionName: string, error: Error): Promise<void> {
    await this.flushBufferedChunks(sessionName, true);
    await this.dispatch(sessionName, {
      kind: "error",
      sessionName,
      text: error.message
    });
  }

  async onQuestion(sessionName: string, question: string): Promise<void> {
    await this.flushBufferedChunks(sessionName, true);
    await this.dispatch(sessionName, {
      kind: "question",
      sessionName,
      text: question.trim()
    });
  }

  flushText(sessionName: string): string {
    const buffer = this.ensureBuffer(sessionName);
    const text = buffer.pending;
    buffer.pending = "";
    return text;
  }

  clear(sessionName: string): void {
    this.buffers.delete(sessionName);
    this.dispatchers.delete(sessionName);
  }

  private ensureBuffer(sessionName: string): SessionBuffer {
    const current = this.buffers.get(sessionName);
    if (current != null) {
      return current;
    }
    const created: SessionBuffer = { pending: "" };
    this.buffers.set(sessionName, created);
    return created;
  }

  private async flushBufferedChunks(sessionName: string, force: boolean): Promise<void> {
    const buffer = this.ensureBuffer(sessionName);
    const threshold = this.options.flushThreshold ?? 240;
    while (buffer.pending.length > 0) {
      const newlineIndex = buffer.pending.indexOf("\n");
      const shouldFlushThreshold = force || newlineIndex >= 0 || buffer.pending.length >= threshold;
      if (!shouldFlushThreshold) {
        return;
      }
      const splitIndex =
        newlineIndex >= 0 ? newlineIndex + 1 : force ? buffer.pending.length : threshold;
      const text = buffer.pending.slice(0, splitIndex);
      buffer.pending = buffer.pending.slice(splitIndex);
      await this.dispatch(sessionName, {
        kind: "chunk",
        sessionName,
        text
      });
      if (!force && newlineIndex < 0) {
        return;
      }
    }
  }

  private async dispatch(sessionName: string, event: OutputRouteEvent): Promise<void> {
    const dispatcher = this.dispatchers.get(sessionName);
    if (dispatcher == null) {
      return;
    }
    try {
      await dispatcher(event);
    } catch (error) {
      const err = ensureError(error);
      this.logger.warn(`Puppenclaw output dispatch failed for ${sessionName}: ${err.message}`);
    }
  }
}
