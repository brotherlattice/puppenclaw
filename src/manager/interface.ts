import type {
  CostParams,
  ForkParams,
  ResumeParams,
  SendParams,
  StartParams,
  StatusParams,
  StopParams,
  ToolResult
} from "../shared/types.js";

export interface ISessionManager {
  start(params: StartParams): Promise<ToolResult>;
  send(params: SendParams): Promise<ToolResult>;
  stop(params: StopParams): Promise<ToolResult>;
  resume(params: ResumeParams): Promise<ToolResult>;
  fork(params: ForkParams): Promise<ToolResult>;
  status(params?: StatusParams): Promise<ToolResult>;
  cost(params: CostParams): Promise<ToolResult>;
  gc(): Promise<void>;
}
