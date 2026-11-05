import { buildModelsList } from "../route.js";
import { getKeyAccessContext, filterModelsListForKey } from "@/sse/services/keyAccess.js";
import {
  ALL_KINDS,
  KIND_SLUG_MAP,
  corsPreflight,
  jsonResponse,
  listEnvelope,
  openAIError,
  serverError,
} from "../modelsHttp.js";

export async function OPTIONS() {
  return corsPreflight("GET, DELETE, OPTIONS");
}

/**
 * GET /v1/models/{kind} - OpenAI-compatible models list filtered by capability.
 * GET /v1/models/{provider}/{model} - OpenAI-compatible single model lookup (any kind).
 * GET /v1/models/{id}?kind=image-to-text - single lookup narrowed to a kind.
 * Supported kinds: image, tts, stt, embedding, image-to-text, web.
 *
 * Resolution order for a bare single segment: a combo (or model) named like a kind slug
 * wins over the kind list, so such a combo stays retrievable; the list stays reachable
 * through GET /v1/models?kind=<slug>.
 */
export async function GET(request, { params }) {
  try {
    const { model } = await params;
    const path = Array.isArray(model) ? model : [model];
    const identifier = path.filter(Boolean).join("/");
    const keyAccess = await getKeyAccessContext(request);

    // Only the requested model is built (combos by name, one provider's catalog), across
    // every kind, hidden combos included — they stay routable so they stay retrievable.
    const lookup = async (id) => {
      const list = await filterModelsListForKey(
        keyAccess,
        await buildModelsList(ALL_KINDS, { id, includeHidden: true }),
      );
      return list.find((candidate) => candidate.id === id) || null;
    };

    const kindFilter = path.length === 1 ? KIND_SLUG_MAP[identifier] : null;
    if (kindFilter) {
      const shadowing = await lookup(identifier);
      if (shadowing) return jsonResponse(shadowing);
      const data = await filterModelsListForKey(keyAccess, await buildModelsList(kindFilter));
      return jsonResponse(listEnvelope(data));
    }

    const matchedModel = await lookup(identifier);
    if (!matchedModel) {
      return openAIError(404, `The model '${identifier}' does not exist or you do not have access to it.`, {
        code: "model_not_found",
        param: "model",
      });
    }
    return jsonResponse(matchedModel);
  } catch (error) {
    console.log("Error fetching model:", error);
    return serverError();
  }
}

/**
 * DELETE /v1/models/{model} — OpenAI deletes fine-tuned models. A routing gateway owns
 * no fine-tunes, so answer in OpenAI's error shape instead of a framework 405 page.
 */
export async function DELETE(request, { params }) {
  const { model } = await params;
  const identifier = (Array.isArray(model) ? model : [model]).filter(Boolean).join("/");
  return openAIError(
    405,
    `Models cannot be deleted through this gateway ('${identifier}'). Manage providers, combos and custom models from the dashboard.`,
    { code: "method_not_allowed", param: "model", headers: { Allow: "GET, OPTIONS" } },
  );
}
