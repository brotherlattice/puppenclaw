import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import {
  artifactListParamsZod,
  campaignActionParamsZod,
  campaignRunParamsZod,
  campaignStatusParamsZod,
  contextSyncParamsZod,
  projectCreateParamsZod,
  reassessmentReportParamsZod,
  reassessmentStartParamsZod,
  reassessmentStatusParamsZod,
  workerManifestZod
} from "../shared/schema.js";
import { ensureError, PuppenclawError } from "../shared/errors.js";
import { getPuppenclawOrchestrator } from "./service.js";

export const PUPPENCLAW_GATEWAY_METHODS = {
  createProject: "puppenclaw.projectCreate",
  registerWorker: "puppenclaw.workerRegister",
  syncContext: "puppenclaw.contextSync",
  runCampaign: "puppenclaw.campaignRun",
  status: "puppenclaw.campaignStatus",
  artifacts: "puppenclaw.artifacts",
  approve: "puppenclaw.campaignApprove",
  cancel: "puppenclaw.campaignCancel",
  startReassessment: "puppenclaw.reassessmentStart",
  reassessmentStatus: "puppenclaw.reassessmentStatus",
  reassessmentReport: "puppenclaw.reassessmentReport"
} as const;

export function registerPuppenclawGatewayMethods(api: OpenClawPluginApi): void {
  if (typeof api.registerGatewayMethod !== "function") {
    return;
  }
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.createProject, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.createProject(projectCreateParamsZod.parse(params))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.registerWorker, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.registerWorker(workerManifestZod.parse(params))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.syncContext, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.syncContext(contextSyncParamsZod.parse(params))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.runCampaign, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.runCampaign(campaignRunParamsZod.parse(params))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.status, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.status(campaignStatusParamsZod.parse(params ?? {}))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.artifacts, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.listArtifacts(artifactListParamsZod.parse(params ?? {}))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.approve, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.approve(campaignActionParamsZod.parse(params))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.cancel, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.cancel(campaignActionParamsZod.parse(params))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.startReassessment, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.startReassessment(reassessmentStartParamsZod.parse(params))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.reassessmentStatus, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.reassessmentStatus(reassessmentStatusParamsZod.parse(params ?? {}))
    );
  }));
  api.registerGatewayMethod(PUPPENCLAW_GATEWAY_METHODS.reassessmentReport, handle(async ({ params }) => {
    return getPuppenclawOrchestrator().then((runtime) =>
      runtime.reassessmentReport(reassessmentReportParamsZod.parse(params))
    );
  }));
}

function handle(
  fn: (opts: GatewayRequestHandlerOptions) => Promise<unknown>
): (opts: GatewayRequestHandlerOptions) => Promise<void> {
  return async (opts) => {
    try {
      opts.respond(true, await fn(opts));
    } catch (error) {
      const err = ensureError(error);
      opts.respond(false, undefined, {
        message: err.message,
        code: error instanceof PuppenclawError ? error.code : "PUPPENCLAW_ERROR"
      });
    }
  };
}
