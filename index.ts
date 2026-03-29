import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";

import {
  PLUGIN_DESCRIPTION,
  PLUGIN_ID,
  PLUGIN_NAME,
  pluginConfigZod
} from "./src/shared/schema.js";
import { registerPuppenclawCommands } from "./src/plugin/commands.js";
import { configurePuppenclawRegistration, createPuppenclawService } from "./src/plugin/service.js";
import { registerPuppenclawTools } from "./src/plugin/tools.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  configSchema: pluginConfigZod,
  register(api: OpenClawPluginApi) {
    configurePuppenclawRegistration(api);
    api.registerService(createPuppenclawService());
    registerPuppenclawTools(api);
    registerPuppenclawCommands(api);
  }
});
