import { Op } from "sequelize";
import { SearchMiss, SearchSynonym } from "../../db/models.js";
import { sequelize } from "../../db/sequelize.js";
import { AppError } from "../../lib/errors.js";
import { newId } from "../../lib/ids.js";
import { likeContains } from "../../lib/like.js";
import { logger } from "../../lib/logger.js";
import { pagination, pageEnvelope } from "../../lib/pagination.js";
import { recordAudit } from "../audits/audit.service.js";

const bnDigits = "০১২৩৪৫৬৭৮৯";

/** Lower-cases, folds Bangla digits, NFC-normalizes and collapses spaces. */
export function normalizeSearchTerm(value: unknown) {
  return (
    String(value ?? "")
      .normalize("NFC")
      // Zero-width joiners/marks are typing artefacts, not search intent.
      .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
      .replace(/[০-৯]/g, (digit) => String(bnDigits.indexOf(digit)))
      .toLowerCase()
      .replace(/[\s\-_/]+/g, " ")
      .trim()
      .slice(0, 80)
  );
}

/**
 * Pure synonym expansion: a set whose term or synonym appears as whole
 * word(s) in the query contributes the query with each alternative spelling
 * (BE-SEARCH-001).
 */
export function expandWithSynonyms(
  query: string,
  sets: { term: string; synonyms: string[] }[],
) {
  const normalized = normalizeSearchTerm(query);
  const terms = new Set([normalized]);
  for (const set of sets) {
    const group = [set.term, ...set.synonyms].map(normalizeSearchTerm);
    // Replace the matched word(s) inside longer queries ("red shalwar" ->
    // "red salwar") so extra words keep narrowing the results.
    const match = group.find((term) => ` ${normalized} `.includes(` ${term} `));
    if (match)
      for (const term of group) terms.add(normalized.replace(match, term));
  }
  return [...terms].filter((term) => term.length >= 2).slice(0, 12);
}

let synonymCache: {
  rows: { term: string; synonyms: string[] }[];
  at: number;
} | null = null;

async function activeSynonyms() {
  if (synonymCache && Date.now() - synonymCache.at < 60_000)
    return synonymCache.rows;
  const rows: RuntimeValue = await SearchSynonym.findAll({
    where: { active: true },
    attributes: ["term", "synonyms"],
  });
  synonymCache = {
    rows: rows.map((row: RuntimeValue) => ({
      term: row.term,
      synonyms: Array.isArray(row.synonyms) ? row.synonyms : [],
    })),
    at: Date.now(),
  };
  return synonymCache.rows;
}

/** True when `a` and `b` differ by at most one insert, delete or substitution. */
function withinOneEdit(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Pure typo tolerance: each query word of 5+ characters that is not a known
 * catalog word is replaced by known words one edit away (BE-SEARCH-001).
 */
export function typoCorrections(query: string, vocabulary: Set<string>) {
  const normalized = normalizeSearchTerm(query);
  const words = normalized.split(" ");
  const corrected = new Set<string>();
  words.forEach((word, index) => {
    if ([...word].length < 5 || vocabulary.has(word)) return;
    for (const known of vocabulary) {
      if (!withinOneEdit(word, known)) continue;
      const next = [...words];
      next[index] = known;
      corrected.add(next.join(" "));
      if (corrected.size >= 4) return;
    }
  });
  return [...corrected];
}

let vocabularyCache: { words: Set<string>; at: number } | null = null;

async function catalogVocabulary() {
  if (vocabularyCache && Date.now() - vocabularyCache.at < 300_000)
    return vocabularyCache.words;
  const [rows]: RuntimeValue = await sequelize.query(
    "SELECT pt.name AS name FROM product_translations pt JOIN products p ON p.id = pt.productId WHERE p.status = 'published' AND p.deletedAt IS NULL UNION SELECT name FROM category_translations",
  );
  const words = new Set<string>();
  for (const row of rows)
    for (const word of normalizeSearchTerm(row.name).split(" "))
      if ([...word].length >= 4) words.add(word);
  vocabularyCache = { words, at: Date.now() };
  return words;
}

export async function searchTerms(query: unknown) {
  const terms = expandWithSynonyms(String(query ?? ""), await activeSynonyms());
  let vocabulary = new Set<string>();
  try {
    vocabulary = await catalogVocabulary();
  } catch (error) {
    logger.warn({ err: error }, "Could not load search vocabulary");
  }
  const corrected = terms.flatMap((term) => typoCorrections(term, vocabulary));
  return [...new Set([...terms, ...corrected])].slice(0, 16);
}

/**
 * Zero-result queries are stored for merchandising, so anything that looks
 * like personal data (email, phone/long number, order reference) is dropped.
 */
export function isLoggableSearchMiss(normalized: string) {
  if (normalized.length < 2) return false;
  if (normalized.includes("@")) return false;
  if ((normalized.match(/\d/g) || []).length >= 6) return false;
  if (/\bee-?\d/.test(normalized)) return false;
  return true;
}

/** Best-effort zero-result logging; never fails the search request. */
export async function recordSearchMiss(query: unknown, locale: unknown) {
  const normalized = normalizeSearchTerm(query);
  if (!isLoggableSearchMiss(normalized)) return;
  const safeLocale = locale === "bn" ? "bn" : "en";
  try {
    await sequelize.query(
      "INSERT INTO search_misses (id, query, locale, count, firstSeenAt, lastSeenAt) VALUES (?, ?, ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE count = count + 1, lastSeenAt = UTC_TIMESTAMP(3)",
      { replacements: [newId(), normalized, safeLocale] },
    );
  } catch (error) {
    logger.warn({ err: error }, "Could not record search miss");
  }
}

function synonymDto(row: RuntimeValue) {
  return {
    id: row.id,
    term: row.term,
    synonyms: row.synonyms,
    active: row.active,
    updatedAt: row.updatedAt,
  };
}

export async function listSynonyms(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const where: RuntimeValue = {};
  if (query.search) where.term = { [Op.like]: likeContains(query.search, 80) };
  const result: RuntimeValue = await SearchSynonym.findAndCountAll({
    where,
    limit,
    offset,
    order: [["term", "ASC"]],
  });
  return {
    data: result.rows.map(synonymDto),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}

export async function saveSynonym(
  id: string | null,
  payload: RuntimeValue,
  actorId: string,
  request: RuntimeValue,
) {
  const term = normalizeSearchTerm(payload.term);
  const synonyms = [
    ...new Set<string>(
      (payload.synonyms || [])
        .map(normalizeSearchTerm)
        .filter((value: string) => value.length >= 2 && value !== term),
    ),
  ];
  if (term.length < 2 || !synonyms.length)
    throw AppError.unprocessable(
      "INVALID_SYNONYM",
      "Enter a term and at least one synonym.",
      { synonyms: ["Enter at least one synonym."] },
    );
  const result = await sequelize.transaction(
    async (transaction: RuntimeValue) => {
      let row: RuntimeValue = id
        ? await SearchSynonym.findByPk(id, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          })
        : null;
      if (id && !row) throw AppError.notFound("Synonym not found.");
      const clash: RuntimeValue = await SearchSynonym.findOne({
        where: { term, ...(row ? { id: { [Op.ne]: row.id } } : {}) },
        transaction,
      });
      if (clash)
        throw AppError.conflict(
          "SYNONYM_EXISTS",
          "This term already has a synonym set.",
        );
      const before = row ? synonymDto(row) : null;
      const values = { term, synonyms, active: payload.active ?? true };
      if (row) await row.update(values, { transaction });
      else
        row = await SearchSynonym.create(
          { id: newId(), ...values },
          { transaction },
        );
      await recordAudit({
        actorId,
        action: before ? "search.synonym_update" : "search.synonym_create",
        resourceType: "search_synonym",
        resourceId: row.id,
        before,
        after: synonymDto(row),
        request,
        transaction,
      });
      return synonymDto(row);
    },
  );
  synonymCache = null;
  return result;
}

export async function deleteSynonym(
  id: string,
  actorId: string,
  request: RuntimeValue,
) {
  await sequelize.transaction(async (transaction: RuntimeValue) => {
    const row: RuntimeValue = await SearchSynonym.findByPk(id, {
      transaction,
    });
    if (!row) throw AppError.notFound("Synonym not found.");
    await recordAudit({
      actorId,
      action: "search.synonym_delete",
      resourceType: "search_synonym",
      resourceId: row.id,
      before: synonymDto(row),
      request,
      transaction,
    });
    await row.destroy({ transaction });
  });
  synonymCache = null;
  return { id, deleted: true };
}

export async function listSearchMisses(query: RuntimeValue) {
  const { page, pageSize, limit, offset }: RuntimeValue = pagination(query);
  const result: RuntimeValue = await SearchMiss.findAndCountAll({
    where: query.locale ? { locale: query.locale } : {},
    limit,
    offset,
    order: [
      ["count", "DESC"],
      ["lastSeenAt", "DESC"],
    ],
  });
  return {
    data: result.rows.map((row: RuntimeValue) => ({
      id: row.id,
      query: row.query,
      locale: row.locale,
      count: row.count,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    })),
    meta: pageEnvelope(result, page, pageSize).meta,
  };
}
