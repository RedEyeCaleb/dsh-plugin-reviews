/**
 * catalog 模块出口。
 *
 * 只导出服务工厂与对外类型；不导出仓储、表定义或 SQL。
 */

export {
  createCatalogService,
  ACCEPT_PLUGIN_ACTION,
  UNCLASSIFIED_TAG,
  UNCATEGORIZED_CATEGORY,
  recordAvailabilityRound,
  UNAVAILABLE_ROUNDS_THRESHOLD,
} from './service';
export type { CatalogServiceDeps } from './service';
export { parseSubmissionUrl, ROOT_PLUGIN_PATH } from './parse-url';
export type { ParsedSubmissionUrl, ParseError } from './parse-url';
export type {
  AcceptPluginSubmissionInput,
  AcceptPluginSubmissionResult,
  CallerContextLike,
  CatalogProbe,
  CatalogService,
  PluginSummary,
  PluginView,
} from './types';
