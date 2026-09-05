/**
 * Public SDK subpath for consuming registered document extractors.
 *
 * The `document-extractor` subpath lets a plugin *provide* an extractor. This one
 * lets a plugin *use* the registered set, which plugins that index customer
 * documents need in order to get text out of PDF and Office files without
 * reaching into core media internals.
 */
export { extractDocumentContent } from "../media/document-extractors.runtime.js";

export type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
