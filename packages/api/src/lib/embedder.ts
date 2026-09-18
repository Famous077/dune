/**
 * The one embedder this Lambda uses. Module scope, so the model loads once per environment
 * and every handler shares it; two instances would load the model twice.
 */

import { createEmbedder } from '@dune/indexer/embed';

export const embedder = createEmbedder();
