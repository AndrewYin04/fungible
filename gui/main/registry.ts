import {
  getRangeSummary,
  getFlexSummary,
  getMerchantSummary,
  getUncategorizedCount,
  getDataBounds,
  getAccountRows,
  getOwnerRows,
  getFilterOptions,
  getCategoryDriftData,
  getFlexDriftData,
  getAccountDriftData,
  getSearchFilteredData,
  countSearchMatches,
  getTransactions,
  getAllCategories,
  getHiddenCategorySet,
  getNetWorthHistory,
  getAccountsWithBalances,
  getLinkedAccounts,
  getCsvAccounts,
  getAllTags,
  getTagSummary,
  getAllRules,
  getAllNameRules,
  getAllTagRules,
  getCategoryDetails,
  toggleHiddenCategory,
  getLastSyncedAt,
} from '../../core/queries.js';
import {
  setTransactionCategory,
  clearTransactionOverride,
  setTransactionIgnored,
  setTransactionDisplayName,
  deleteTransaction,
  upsertCategoryRule,
  upsertNameRule,
  setTransactionCategoryBulk,
  clearOverridesBulk,
  setIgnoredBulk,
} from '../../core/transactions.js';
import {
  getTagOptions,
  getTransactionTagIds,
  getOrCreateTag,
  addTagToTransaction,
  removeTagFromTransaction,
  addTagToTransactions,
  createTag,
  renameTag,
  deleteTag,
} from '../../core/tags.js';
import { countPatternMatches } from '../../core/rule-utils.js';
import { countTagRuleMatches } from '../../core/tag-rules.js';
import {
  getUncategorizedCount as getTotalUncategorizedCount,
  deleteCategoryRule,
  deleteNameRule,
  saveCategoryRule,
  saveNameRule,
  saveTagRule,
  deleteTagRule,
  setCategoryFlexibility,
  createCategory,
  deleteCategory,
  renameCategory,
} from '../../core/rules.js';
import { loadHealthData, yearsToFire, coastYears } from '../../core/health.js';
import { getSetting, setSetting, PRETAX_MONTHLY_KEY } from '../../core/settings.js';
import {
  buildTrendViews,
  getPeriodTotals,
  getSearchPeriodTotals,
  getSearchMatchingPeriods,
} from '../../core/trends.js';
import {
  updateAccountTypeSubtype,
  updateAccountNickname,
  updateAccountOwner,
  updateAccountApr,
  updateAccountExcluded,
  updateAccountValue,
  createManualAccount,
  createCsvAccount,
  deleteAccount,
  importCsvTransactions,
  deleteDuplicate,
  deleteAllDuplicates,
} from '../../core/accounts.js';
import { getCsvPlaidDupeCandidates } from '../../core/dedup.js';
import { applyCategoriesToAll } from '../../core/categorize.js';
import { loadProfile, saveProfile, householdMembers } from '../../core/profile.js';
import { syncAll } from '../../core/sync.js';
import { setSyncResult, getSyncFailures } from '../../core/sync-status.js';
import { loadHistory, deleteHistoryEntry, CANVAS_SPEC_PATH } from '../../core/canvas-history.js';
import type { CanvasSpec } from '../../core/canvas-spec.js';
import { writeEnvFile, type EnvUpdates } from '../../core/env-file.js';
import { readFileSync } from 'node:fs';

/**
 * The env keys the GUI's Configuration panel offers, and therefore the only
 * ones a renderer call may set. Taken from CONFIG_FIELDS plus the Plaid
 * environment select in gui/renderer/src/screens/Settings.tsx — the test in
 * tests/gui/ipc-surface.test.ts compares this list against that file, so the
 * two cannot drift apart.
 *
 * writeEnvFile itself takes any well-formed key: the TUI Setup wizard is a
 * local program run by the owner, but the renderer is a browser context, and
 * every key outside this list is one nobody using the app can ask for. The
 * ones that matter: ANTHROPIC_BASE_URL / OPENAI_BASE_URL are read straight out
 * of the environment by the LLM SDKs, so writing one sends the owner's
 * financial context to whatever host it names; FUNGIBLE_BIND_HOST and
 * FUNGIBLE_API_KEY decide who can reach the local API; FUNGIBLE_DATA_DIR moves
 * the database itself.
 */
export const WRITABLE_ENV_KEYS = [
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

// Explicit picks (no module spreads): keeps the IPC surface intentional and
// excludes non-structured-cloneable exports like buildSearchRe.
// Electron-free on purpose — tests import this without an electron runtime.
export const registry = {
  queries: {
    getRangeSummary,
    getFlexSummary,
    getMerchantSummary,
    getUncategorizedCount,
    getDataBounds,
    getAccountRows,
    getOwnerRows,
    getFilterOptions,
    getCategoryDriftData,
    getFlexDriftData,
    getAccountDriftData,
    getSearchFilteredData,
    countSearchMatches,
    getTransactions,
    getAllCategories,
    getHiddenCategorySet,
    getNetWorthHistory,
    getAccountsWithBalances,
    getLinkedAccounts,
    getCsvAccounts,
    getAllTags,
    getTagSummary,
  },
  transactions: {
    setTransactionCategory,
    clearTransactionOverride,
    setTransactionIgnored,
    setTransactionDisplayName,
    deleteTransaction,
    upsertCategoryRule,
    upsertNameRule,
    setTransactionCategoryBulk,
    clearOverridesBulk,
    setIgnoredBulk,
  },
  tags: {
    getTagOptions,
    getTransactionTagIds,
    getOrCreateTag,
    addTagToTransaction,
    removeTagFromTransaction,
    addTagToTransactions,
    createTag,
    renameTag,
    deleteTag,
  },
  rules: {
    countPatternMatches,
    countTagRuleMatches,
    getAllRules,
    getAllNameRules,
    getAllTagRules,
    getCategoryDetails,
    toggleHiddenCategory,
    getTotalUncategorizedCount,
    deleteCategoryRule,
    deleteNameRule,
    saveCategoryRule,
    saveNameRule,
    saveTagRule,
    deleteTagRule,
    setCategoryFlexibility,
    createCategory,
    deleteCategory,
    renameCategory,
  },
  health: {
    loadHealthData,
    yearsToFire,
    coastYears,
  },
  trends: {
    buildTrendViews,
    getPeriodTotals,
    getSearchPeriodTotals,
    getSearchMatchingPeriods,
  },
  accounts: {
    updateAccountTypeSubtype,
    updateAccountNickname,
    updateAccountOwner,
    updateAccountApr,
    updateAccountExcluded,
    updateAccountValue,
    createManualAccount,
    createCsvAccount,
    deleteAccount,
    importCsvTransactions,
    deleteDuplicate,
    deleteAllDuplicates,
    getCsvPlaidDupeCandidates,
  },
  categorize: {
    applyCategoriesToAll,
  },
  profile: {
    loadProfile,
    saveProfile,
    getHouseholdMembers: async (): Promise<string[]> => householdMembers(await loadProfile()),
  },
  canvas: {
    loadHistory,
    deleteHistoryEntry,
    loadCurrentSpec: async (): Promise<(CanvasSpec & { _writtenAt?: number }) | null> => {
      try {
        return JSON.parse(readFileSync(CANVAS_SPEC_PATH, 'utf-8'));
      } catch {
        return null;
      }
    },
  },
  sync: {
    // Wrap so every user-triggered sync records its outcome in the shared store,
    // which drives the renderer banner + row badges via the sync-status push.
    syncAll: async (force?: boolean) => {
      const results = await syncAll(force);
      setSyncResult(results);
      return results;
    },
    // Initial hydration for a renderer that mounts after a background sync failed.
    getStatus: async () => getSyncFailures(),
    getLastSyncedAt,
  },
  config: {
    // A key given with an empty value REMOVES it from .env (core/env-file.ts).
    // The renderer's Configuration panel says a blank field keeps the current
    // value, so it does not send blank fields at all — both halves of that
    // contract have to stay true, and `cleared` is reported rather than
    // swallowed so a caller that does send one is not told "saved 0 values".
    writeEnv: async (updates: EnvUpdates): Promise<{ written: string[]; cleared: string[] }> => {
      if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
        throw new Error('config.writeEnv expects an object of env keys');
      }
      // Refuse the whole call, loudly, rather than dropping the unknown keys:
      // a caller told "saved" while a key it asked for was ignored learns
      // nothing, and the owner never sees that something asked for a key the
      // panel does not offer.
      const refused = Object.keys(updates).filter(
        (k) => !(WRITABLE_ENV_KEYS as readonly string[]).includes(k),
      );
      if (refused.length > 0) {
        throw new Error(
          `config.writeEnv refused ${refused.join(', ')}: the Configuration panel sets only ${WRITABLE_ENV_KEYS.join(', ')}`,
        );
      }
      const { written, cleared } = writeEnvFile(updates);
      return { written, cleared };
    },
  },
  settings: {
    getPretaxMonthly: () => getSetting(PRETAX_MONTHLY_KEY),
    setPretaxMonthly: (v: string) => setSetting(PRETAX_MONTHLY_KEY, v),
  },
} as const;
