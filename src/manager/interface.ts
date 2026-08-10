import type {
  CostParams,
  FocusParams,
  ForkParams,
  QuiesceParams,
  QuiescenceReleaseParams,
  ResumeParams,
  SendParams,
  StartParams,
  StatusParams,
  StopParams,
  SuspendParams,
  ToolResult,
  UnfocusParams
} from "../shared/types.js";

export interface ISessionManager {
  start(params: StartParams): Promise<ToolResult>;
  send(params: SendParams): Promise<ToolResult>;
  stop(params: StopParams): Promise<ToolResult>;
  resume(params: ResumeParams): Promise<ToolResult>;
  suspend(params: SuspendParams): Promise<ToolResult>;
  focus(params: FocusParams): Promise<ToolResult>;
  unfocus(params: UnfocusParams): Promise<ToolResult>;
  fork(params: ForkParams): Promise<ToolResult>;
  status(params?: StatusParams): Promise<ToolResult>;
  output(params: StatusParams): Promise<ToolResult>;
  cost(params?: CostParams): Promise<ToolResult>;
  purge(params: StopParams): Promise<ToolResult>;
  quiesce(params: QuiesceParams): Promise<ToolResult>;
  releaseQuiescence(params: QuiescenceReleaseParams): Promise<ToolResult>;
  gc(): Promise<void>;
  /**
   * Optional startup sweep that marks persisted running sessions with dead
   * turn processes as terminal. Implemented by managers that own the session
   * store directly; the daemon-backed manager relies on the daemon running
   * the sweep itself at startup.
   */
  reconcilePersistedSessions?(): Promise<void>;
}
