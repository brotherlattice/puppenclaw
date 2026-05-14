import type {
  CostParams,
  FocusParams,
  ForkParams,
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
  cost(params: CostParams): Promise<ToolResult>;
  gc(): Promise<void>;
}
