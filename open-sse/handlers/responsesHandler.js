import { handleChatCore } from "./chatCore.js";
import { FORMATS } from "../translator/formats.js";

/** Handle a Responses request in the shared chat pipeline. */
export function handleResponsesCore(options) {
  return handleChatCore({ ...options, sourceFormatOverride: FORMATS.OPENAI_RESPONSES });
}
