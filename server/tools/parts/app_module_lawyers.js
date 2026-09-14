// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Lawyer marketplace API for the Vakil AI app worker: public
//             directory search (verified lawyers only), public/self profile
//             view, "apply as lawyer" self-upgrade, lawyer profile editing,
//             and the specialty-category list.
// OWNER     — Agent 4 — Lawyer Backend.
// CONSUMES  — marketplaceRegister/marketplaceEnsureTables/marketplaceRequireRole/
//             marketplaceRequireToken/marketplaceAccount/marketplaceNow/
//             marketplaceJsonArray/marketplaceSlugify (app_module_common.js),
//             appApiJson/appApiErr/appApiVerifyToken (app_module_head.js),
//             D1 tables lawyer_profiles + app_accounts + lawyer_categories
//             (created by app_module_schema.js — Agent 3; this file never DDLs).
// PROVIDES  — POST /api/v1/lawyers/list      → {ok, lawyers[], total, message?}
//             POST /api/v1/lawyers/get       → LawyerProfileResponse (public or self)
//             POST /api/v1/lawyers/me        → LawyerProfileResponse (own, + note)
//             POST /api/v1/lawyers/save      → LawyerProfileResponse (after edit)
//             POST /api/v1/lawyers/apply     → LawyerProfileResponse (same as /me)
//             POST /api/v1/lawyers/categories→ {ok, categories[]}
//             Response JSON keys match src/VakilAI.Application/Contracts/
//             MarketplaceContracts.cs (LawyerListItem / LawyerProfileResponse /
//             LawyerCategory) camelCase 1:1.
// INVARIANTS— 1) verification_status, verification_note, verified_at/by, role,
//                user_id and slug are NEVER writable from client input: the
//                save UPDATE is built from a fixed field whitelist
//                (LAWYERS_EDITABLE_FIELDS) and those columns are simply not in
//                it, so no request shape can reach them. Only Agent 6's admin
//                decision endpoint may verify/reject.
//             2) The directory (list) and public profile (get) expose ONLY
//                rows where lp.verification_status='verified' AND
//                aa.status='active' AND aa.role='lawyer'. pending/rejected/
//                suspended rows are never visible to anyone except their own
//                owner via /me or self-view in /get.
//             3) Any save by a verified lawyer sends the profile back to
//                'pending' (re-review rule, spec §4). The only exception is the
//                server-side env flag KEEP_VERIFIED_ON_EDIT === "1"; the client
//                can never influence it.
//             4) No fabricated data: zero matching lawyers returns
//                {ok:true, lawyers:[], total:0}. No ratings/reviews exist here.
//             5) Cards never carry bio or any contact info; bio appears only in
//                the full profile view.
//             6) All SQL goes through D1 bind parameters (never string
//                interpolation of user data); LIKE wildcards are escaped and
//                every ORDER BY comes from a fixed whitelist map.
// EXTEND    — New profile columns: add them to LAWYERS_PROFILE_COLUMNS, the
//             whitelist and the view builder; new filters: push into the
//             lawyersBuildListWhere clauses array + bind array; new sort: add a
//             key to LAWYERS_ORDERS. Keep Agent 3's schema and the .NET
//             contracts in sync via MARKETPLACE_INTEGRATION_REQUESTS.md.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── constants ───────────────────────────
const LAWYERS_PAGE_MAX = 40;          // hard row cap per directory page
const LAWYERS_DEFAULT_DURATION = 45;  // matches the schema column default

// Fixed projection for profile reads (self + owner views).
const LAWYERS_PROFILE_COLUMNS = [
  "lp.user_id", "lp.slug", "lp.title", "lp.bio", "lp.specialties", "lp.languages",
  "lp.city", "lp.jurisdiction", "lp.experience_years", "lp.price_toman",
  "lp.duration_minutes", "lp.availability_note", "lp.is_available",
  "lp.verification_status", "lp.verification_note", "lp.photo_url",
  "lp.created_at", "lp.updated_at",
  "aa.display_name", "aa.role", "aa.status"
].join(", ");

// Directory cards only — deliberately NO bio and no contact information.
const LAWYERS_CARD_COLUMNS = [
  "lp.user_id", "lp.slug", "lp.title", "lp.specialties", "lp.city",
  "lp.experience_years", "lp.price_toman", "lp.duration_minutes",
  "lp.is_available", "lp.verification_status", "lp.photo_url", "lp.created_at",
  "aa.display_name"
].join(", ");

// Only the always-verified/public predicate; filters are appended on top.
const LAWYERS_PUBLIC_WHERE = ["lp.verification_status = 'verified'", "aa.status = 'active'", "aa.role = 'lawyer'"];

// Sort whitelist — ORDER BY text is NEVER taken from the request body.
const LAWYERS_ORDERS = {
  experience: "lp.experience_years IS NULL, lp.experience_years DESC, lp.created_at DESC, lp.user_id DESC",
  price_asc: "lp.price_toman IS NULL, lp.price_toman ASC, lp.created_at DESC, lp.user_id DESC",
  price_desc: "lp.price_toman IS NULL, lp.price_toman DESC, lp.created_at DESC, lp.user_id DESC",
  recent: "lp.created_at IS NULL, lp.created_at DESC, lp.user_id DESC"
};

/**
 * The complete writable surface of /lawyers/save. Every entry is
 * [requestField, column, kind, minOrMaxItems, maxLenOrMaxValue] — int kinds use
 * slot 4 as the lower bound, list kinds use it as the item cap. Anything not listed here
 * (verification_status, role, user_id, slug, verified_*) is unreachable from
 * client input BY CONSTRUCTION, which is how INVARIANT 1 is enforced.
 */
const LAWYERS_EDITABLE_FIELDS = [
  ["title", "title", "text", null, 80],
  ["bio", "bio", "text", null, 1500],
  ["city", "city", "text", null, 60],
  ["jurisdiction", "jurisdiction", "text", null, 80],
  ["availabilityNote", "availability_note", "text", null, 300],
  ["photoUrl", "photo_url", "url", null, 600],
  ["specialties", "specialties", "list", 12, 40],
  ["languages", "languages", "list", 12, 40],
  ["experienceYears", "experience_years", "int", 0, 60],
  ["priceToman", "price_toman", "int", 0, 50000000],
  ["durationMinutes", "duration_minutes", "int", 15, 180],
  ["isAvailable", "is_available", "bool", null, null]
];

// ─────────────────────────── private helpers (prefix: lawyers) ───────────────────────────

/** Uniform 500 for D1/unexpected failures — logged, Persian message, never thrown. */
function lawyersError(route, err) {
  console.error(`[${route}] failed:`, (err && (err.stack || err.message)) || err);
  return appApiErr("INTERNAL", "مشکلی در سرور پیش آمد. لطفاً کمی بعد تلاش کنید.", 500);
}

/** Missing/anonymous/expired token must not break a public route → null. */
async function lawyersOptionalPayload(env, body) {
  try { return await appApiVerifyToken(env, body && body.token); }
  catch (e) { console.warn("optional token verify failed:", e && e.message); return null; }
}

/**
 * Escapes LIKE metacharacters for a pattern bound as a parameter and used with
 * `ESCAPE '\'`. Quote doubling is intentionally NOT done: values are bound, so
 * `'` is data, not syntax, and doubling it would corrupt real searches
 * ("O'Brien" would stop matching).
 */
function lawyersLikeEscape(raw) {
  return String(raw == null ? "" : raw)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/** Trim + cap a string; returns "" for non-strings. */
function lawyersStr(raw, maxLen) {
  const s = typeof raw === "string" ? raw.trim() : (raw == null ? "" : String(raw).trim());
  const cap = maxLen || 500;
  return s.length > cap ? s.slice(0, cap) : s;
}

/** Integer clamp; returns null when the value is absent or not a finite number. */
function lawyersInt(raw, min, max) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Directory/search filter value: integer clamp that rejects garbage explicitly. */
function lawyersIntParam(raw, min, max) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined; // sentinel: caller reports VALIDATION
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Coerces a JSON-array column / request array into ≤maxItems short strings. */
function lawyersStringList(raw, maxItems, maxItemLen) {
  let src = raw;
  if (typeof src === "string") src = marketplaceJsonArray(src);
  if (!Array.isArray(src)) return [];
  const seen = Object.create(null);
  const out = [];
  for (const item of src) {
    // Scalars only: an object/boolean/null in the array is junk, not a label.
    const scalar = typeof item === "string" || (typeof item === "number" && Number.isFinite(item));
    if (!scalar) continue;
    const v = lawyersStr(item, maxItemLen || 40);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(v);
    if (out.length >= (maxItems || 12)) break;
  }
  return out;
}

/** SQLite INTEGER 0/1 → JSON boolean (absent column keeps the schema default). */
function lawyersBool(raw, fallback) {
  if (raw === null || raw === undefined) return fallback !== false;
  return Number(raw) !== 0;
}

/** LawyerListItem card — camelCase per MarketplaceContracts.cs. */
function lawyersCard(row) {
  return {
    userId: Number(row.user_id),
    slug: row.slug || null,
    displayName: row.display_name || "",
    title: row.title || null,
    city: row.city || null,
    experienceYears: row.experience_years == null ? null : Number(row.experience_years),
    specialties: lawyersStringList(row.specialties, 12, 40),
    priceToman: row.price_toman == null ? null : Number(row.price_toman),
    durationMinutes: Number(row.duration_minutes) || LAWYERS_DEFAULT_DURATION,
    isAvailable: lawyersBool(row.is_available, true),
    verificationStatus: row.verification_status || "pending",
    photoUrl: row.photo_url || null
  };
}

/**
 * LawyerProfileResponse view. verificationNote is emitted for the owner only
 * (INVARIANT: public views never leak admin notes).
 */
function lawyersProfileView(row, isSelf) {
  return {
    userId: Number(row.user_id),
    slug: row.slug || null,
    displayName: row.display_name || "",
    title: row.title || null,
    bio: row.bio || null,
    specialties: lawyersStringList(row.specialties, 12, 40),
    languages: lawyersStringList(row.languages, 12, 40),
    city: row.city || null,
    jurisdiction: row.jurisdiction || null,
    experienceYears: row.experience_years == null ? null : Number(row.experience_years),
    priceToman: row.price_toman == null ? null : Number(row.price_toman),
    durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    availabilityNote: row.availability_note || null,
    isAvailable: lawyersBool(row.is_available, true),
    verificationStatus: row.verification_status || "pending",
    verificationNote: isSelf ? (row.verification_note || null) : null,
    photoUrl: row.photo_url || null,
    isSelf: Boolean(isSelf)
  };
}

/** Loads one profile joined to its account row; column is a hard-coded key. */
async function lawyersLoadProfile(env, column, value) {
  const row = await env.DB.prepare(
    `SELECT ${LAWYERS_PROFILE_COLUMNS} FROM lawyer_profiles lp ` +
    "JOIN app_accounts aa ON aa.user_id = lp.user_id " +
    `WHERE lp.${column} = ? LIMIT 1`
  ).bind(value).first();
  return row || null;
}

/** True only for the directory-eligible state (verified + active + lawyer). */
function lawyersIsPublic(row) {
  return !!row && row.verification_status === "verified" && row.status === "active" && row.role === "lawyer";
}

const LAWYERS_NOT_FOUND = "پروفایل وکیل مورد نظر یافت نشد یا هنوز تأیید نشده است.";

/** Success envelope for every profile-returning route (me/get/apply/save). */
function lawyersProfileResponse(row, isSelf, message) {
  const payload = lawyersProfileView(row, isSelf);
  payload.ok = true;
  if (message) payload.message = message;
  return appApiJson(payload);
}

/** Owner-facing status line that says plainly when the lawyer is still pending. */
function lawyersOwnerMessage(row, createdNow) {
  const status = row.verification_status || "pending";
  if (createdNow) {
    return "درخواست شما به‌عنوان وکیل ثبت شد و در انتظار بررسی تیم تأیید است.";
  }
  if (status === "pending") {
    return "پروفایل شما در حال حاضر «در انتظار بررسی» است؛ پس از تأیید تیم، در دفترچه وکلا نمایش داده می‌شود.";
  }
  if (status === "verified") {
    return "پروفایل شما تأیید شده است و در دفترچه وکلا فعال است.";
  }
  if (status === "rejected") {
    return "پروفایل شما در بررسی رد شده است. برای آگاهی از دلیل، به یادداشت تأیید پروفایل خود نگاه کنید.";
  }
  if (status === "suspended") {
    return "تأیید پروفایل شما موقتاً لغو شده است و در دفترچه وکلا نمایش داده نمی‌شود.";
  }
  return "پروفایل شما بارگذاری شد.";
}

/** Generates an unused slug (marketplaceSlugify already carries a random tail). */
async function lawyersFreshSlug(env, displayName) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = marketplaceSlugify(displayName);
    const clash = await env.DB.prepare("SELECT 1 AS hit FROM lawyer_profiles WHERE slug = ? LIMIT 1")
      .bind(candidate).first();
    if (!clash) return candidate;
  }
  return marketplaceSlugify(displayName) + "-" + Date.now().toString(36);
}

// ─────────────────────────── handlers ───────────────────────────

/**
 * POST /api/v1/lawyers/list — public directory search.
 * body {token?, query?, category?, city?, maxPrice?, sort?, limit?, offset?}
 * → {ok, lawyers[LawyerListItem], total, message?}. Filters:
 *   query     → case-insensitive LIKE on display_name / title / bio / city
 *   category  → slug containment inside the specialties JSON array
 *   city      → exact equality (case-sensitive, as stored)
 *   maxPrice  → price_toman <= n, NULL prices kept (they sort last)
 *   sort      → experience (default) | price_asc | price_desc | recent
 * Only verified + active + lawyer rows are ever considered.
 * Errors: VALIDATION (bad maxPrice), INTERNAL.
 */
async function lawyersHandleList(env, ctx, body) {
  try {
    await marketplaceEnsureTables(env);
    const req = body || {};

    const clauses = LAWYERS_PUBLIC_WHERE.slice();
    const args = [];

    const q = lawyersStr(req.query, 60);
    if (q.length >= 2) {
      const like = "%" + lawyersLikeEscape(q) + "%";
      clauses.push("(aa.display_name LIKE ? ESCAPE '\\' OR lp.title LIKE ? ESCAPE '\\' " +
        "OR lp.bio LIKE ? ESCAPE '\\' OR lp.city LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }

    const category = lawyersStr(req.category, 40).toLowerCase();
    if (category) {
      clauses.push("lp.specialties LIKE ? ESCAPE '\\'");
      args.push('%"' + lawyersLikeEscape(category) + '"%');
    }

    const city = lawyersStr(req.city, 60);
    if (city) { clauses.push("lp.city = ?"); args.push(city); }

    if (req.maxPrice !== null && req.maxPrice !== undefined && req.maxPrice !== "") {
      const maxPrice = lawyersIntParam(req.maxPrice, 0, 50000000);
      if (maxPrice === undefined) {
        return appApiErr("VALIDATION", "حداکثر قیمت ارسال‌شده معتبر نیست.", 400);
      }
      clauses.push("(lp.price_toman IS NULL OR lp.price_toman <= ?)");
      args.push(maxPrice);
    }

    // `token` is accepted from the client but changes nothing here: the public
    // view is identical for anonymous and signed-in callers (spec §4).

    // Own-property lookup only, so inherited keys ("constructor", "__proto__")
    // can never leak a function into the ORDER BY text.
    const requestedSort = typeof req.sort === "string" ? req.sort : "";
    const sortKey = Object.prototype.hasOwnProperty.call(LAWYERS_ORDERS, requestedSort) ? requestedSort : "experience";
    const limit = lawyersInt(req.limit, 1, LAWYERS_PAGE_MAX) || LAWYERS_PAGE_MAX;
    const offset = lawyersInt(req.offset, 0, 1000000) || 0;
    const where = "WHERE " + clauses.join(" AND ");

    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM lawyer_profiles lp JOIN app_accounts aa ON aa.user_id = lp.user_id " + where
    ).bind(...args).first();
    const total = totalRow && Number.isFinite(Number(totalRow.n)) ? Number(totalRow.n) : 0;

    const page = await env.DB.prepare(
      `SELECT ${LAWYERS_CARD_COLUMNS} FROM lawyer_profiles lp JOIN app_accounts aa ON aa.user_id = lp.user_id ` +
      where + ` ORDER BY ${LAWYERS_ORDERS[sortKey]} LIMIT ? OFFSET ?`
    ).bind(...args, limit, offset).all();

    const lawyers = (page && Array.isArray(page.results) ? page.results : []).map(lawyersCard);
    const out = { ok: true, lawyers: lawyers, total: total, hasMore: offset + lawyers.length < total };
    if (total === 0) {
      out.message = "هنوز وکیل تأیید‌شده‌ای با این جستجو یافت نشد. دفترچه خالی بودن داده، نه نبود سرویس.";
    }
    return appApiJson(out);
  } catch (e) {
    return lawyersError("lawyers/list", e);
  }
}

/**
 * POST /api/v1/lawyers/get — one profile by {userId} or {slug}, token optional.
 * Verified+active+lawyer rows only, EXCEPT for the owner, who gets the full
 * self view (isSelf=true, verificationNote included).
 * Errors: VALIDATION (no id given), NOT_FOUND (404), INTERNAL.
 */
async function lawyersHandleGet(env, ctx, body) {
  try {
    await marketplaceEnsureTables(env);
    const req = body || {};
    const userId = lawyersInt(req.userId, 1, Number.MAX_SAFE_INTEGER);
    const slug = lawyersStr(req.slug, 60).toLowerCase();
    if (!userId && !slug) {
      return appApiErr("VALIDATION", "شناسه پروفایل (userId یا slug) ارسال نشده است.", 400);
    }

    let row = null;
    if (userId) row = await lawyersLoadProfile(env, "user_id", userId);
    if (!row && slug) row = await lawyersLoadProfile(env, "slug", slug);

    const payload = await lawyersOptionalPayload(env, req);
    const isSelf = !!(payload && row && String(payload.uid) === String(row.user_id));

    if (!row || (!isSelf && !lawyersIsPublic(row))) {
      return appApiErr("NOT_FOUND", LAWYERS_NOT_FOUND, 404);
    }
    return lawyersProfileResponse(row, isSelf, isSelf ? lawyersOwnerMessage(row, false) : null);
  } catch (e) {
    return lawyersError("lawyers/get", e);
  }
}

/**
 * POST /api/v1/lawyers/me — the caller's own profile (lawyer role only),
 * including verificationStatus and the admin verificationNote.
 * Errors: UNAUTHORIZED (401), FORBIDDEN (403), NOT_FOUND (404), INTERNAL.
 */
async function lawyersHandleMe(env, ctx, body) {
  try {
    await marketplaceEnsureTables(env);
    const auth = await marketplaceRequireRole(env, body, "lawyer");
    if (auth.err) return auth.err;

    const row = await lawyersLoadProfile(env, "user_id", auth.account.user_id);
    if (!row) {
      return appApiErr("NOT_FOUND", "شما هنوز پروفایل وکیل ندارید. برای ساخت آن از گزینهٔ «پذیرش به‌عنوان وکیل» استفاده کنید.", 404);
    }
    return lawyersProfileResponse(row, true, lawyersOwnerMessage(row, false));
  } catch (e) {
    return lawyersError("lawyers/me", e);
  }
}

/**
 * POST /api/v1/lawyers/apply — a client upgrades their OWN account to lawyer.
 * Guards on role client|lawyer (admin is explicitly refused by omission), sets
 * app_accounts.role='lawyer' and INSERTs a pending lawyer_profiles row with a
 * fresh slug. Idempotent: an existing profile is returned unchanged.
 * Returns the same payload as /lawyers/me.
 * Errors: UNAUTHORIZED (401), FORBIDDEN (403), INTERNAL.
 */
async function lawyersHandleApply(env, ctx, body) {
  try {
    await marketplaceEnsureTables(env);
    const auth = await marketplaceRequireRole(env, body, "client", "lawyer");
    if (auth.err) return auth.err;
    const account = auth.account;
    const userId = account.user_id;

    const existing = await lawyersLoadProfile(env, "user_id", userId);
    if (existing) {
      if (existing.role !== "lawyer") {
        await env.DB.prepare("UPDATE app_accounts SET role = 'lawyer' WHERE user_id = ?").bind(userId).run();
        existing.role = "lawyer";
      }
      return lawyersProfileResponse(existing, true,
        existing.verification_status === "verified"
          ? "پروفایل وکیل شما از قبل ثبت و تأیید شده است."
          : lawyersOwnerMessage(existing, false));
    }

    await env.DB.prepare("UPDATE app_accounts SET role = 'lawyer' WHERE user_id = ?").bind(userId).run();

    const now = marketplaceNow();
    const slug = await lawyersFreshSlug(env, account.display_name || "vakil");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO lawyer_profiles (user_id, slug, verification_status, duration_minutes, is_available, created_at, updated_at) " +
      "VALUES (?, ?, 'pending', ?, 1, ?, ?)"
    ).bind(userId, slug, LAWYERS_DEFAULT_DURATION, now, now).run();

    const created = await lawyersLoadProfile(env, "user_id", userId);
    if (!created) {
      return appApiErr("INTERNAL", "پروفایل وکیل ساخته نشد. لطفاً دوباره تلاش کنید.", 500);
    }
    return lawyersProfileResponse(created, true, lawyersOwnerMessage(created, true));
  } catch (e) {
    return lawyersError("lawyers/apply", e);
  }
}

/**
 * POST /api/v1/lawyers/save — lawyer edits their own profile.
 * Only the LAWYERS_EDITABLE_FIELDS whitelist is written; omitted/null fields are
 * left untouched (null means "not provided" per the client contract), an empty
 * string clears a text column. A verified profile drops back to 'pending'.
 * Errors: UNAUTHORIZED (401), FORBIDDEN (403), NOT_FOUND (404), VALIDATION (400), INTERNAL.
 */
async function lawyersHandleSave(env, ctx, body) {
  try {
    await marketplaceEnsureTables(env);
    const auth = await marketplaceRequireRole(env, body, "lawyer");
    if (auth.err) return auth.err;
    const req = body || {};

    const row = await lawyersLoadProfile(env, "user_id", auth.account.user_id);
    if (!row) {
      return appApiErr("NOT_FOUND", "شما هنوز پروفایل وکیل ندارید. برای ساخت آن از گزینهٔ «پذیرش به‌عنوان وکیل» استفاده کنید.", 404);
    }

    const sets = [];
    const args = [];
    let provided = 0;

    for (const field of LAWYERS_EDITABLE_FIELDS) {
      const name = field[0], column = field[1], kind = field[2], min = field[3], max = field[4];
      if (!Object.prototype.hasOwnProperty.call(req, name)) continue;
      const raw = req[name];
      if (raw === null || raw === undefined) continue; // "not provided" — never coerced

      if (kind === "text") {
        const v = lawyersStr(raw, max);
        sets.push(`${column} = ?`);
        args.push(v === "" ? null : v);
        provided++;
      } else if (kind === "list") {
        const list = lawyersStringList(raw, min, max);
        sets.push(`${column} = ?`);
        args.push(JSON.stringify(list));
        provided++;
      } else if (kind === "int") {
        const n = lawyersIntParam(raw, min, max);
        if (n === undefined) {
          return appApiErr("VALIDATION", `مقدار «${name}» یک عدد معتبر نیست.`, 400);
        }
        sets.push(`${column} = ?`);
        args.push(n);
        provided++;
      } else if (kind === "bool") {
        sets.push(`${column} = ?`);
        args.push(raw === false || raw === 0 || raw === "0" || raw === "false" ? 0 : 1);
        provided++;
      } else if (kind === "url") {
        const v = lawyersStr(raw, max);
        if (v === "") { sets.push(`${column} = ?`); args.push(null); provided++; continue; }
        if (!/^https?:\/\/\S+$/i.test(v)) {
          return appApiErr("VALIDATION", "آدرس تصویر پروفایل معتبر نیست (باید با http یا https شروع شود).", 400);
        }
        sets.push(`${column} = ?`);
        args.push(v);
        provided++;
      }
    }

    if (provided === 0) {
      return appApiErr("VALIDATION", "هیچ اطلاعاتی برای ذخیرهٔ پروفایل ارسال نشد.", 400);
    }

    // Re-review rule (spec §4): an edit by a verified lawyer un-publishes them.
    const wasVerified = row.verification_status === "verified";
    const keepVerified = String(env.KEEP_VERIFIED_ON_EDIT || "") === "1";
    if (wasVerified && !keepVerified) {
      sets.push("verification_status = 'pending'");
    }
    sets.push("updated_at = ?");
    args.push(marketplaceNow());

    await env.DB.prepare(
      `UPDATE lawyer_profiles SET ${sets.join(", ")} WHERE user_id = ?`
    ).bind(...args, auth.account.user_id).run();

    const after = await lawyersLoadProfile(env, "user_id", auth.account.user_id);
    if (!after) return appApiErr("INTERNAL", "پروفایل پس از ذخیره قابل خواندن نیست.", 500);

    let message = "پروفایل شما ذخیره شد.";
    if (wasVerified && after.verification_status === "pending") {
      message = "پروفایل شما ذخیره شد؛ چون پس از ویرایش باید دوباره بررسی شود، وضعیت تأیید شما به «در انتظار بررسی» بازگشت.";
    } else if (after.verification_status === "pending") {
      message = "پروفایل شما ذخیره شد. پس از تأیید تیم، در دفترچه وکلا نمایش داده می‌شود.";
    }
    return lawyersProfileResponse(after, true, message);
  } catch (e) {
    return lawyersError("lawyers/save", e);
  }
}

/**
 * POST /api/v1/lawyers/categories — public specialty list.
 * body {} → {ok, categories:[{slug, nameFa, nameEn}]} ordered by sort.
 * Empty table = empty array (no seeded/fake categories here). Errors: INTERNAL.
 */
async function lawyersHandleCategories(env, ctx, body) {
  try {
    await marketplaceEnsureTables(env);
    const page = await env.DB.prepare(
      "SELECT slug, name_fa, name_en, sort FROM lawyer_categories " +
      "ORDER BY sort IS NULL, sort ASC, slug ASC"
    ).all();
    const rows = page && Array.isArray(page.results) ? page.results : [];
    const categories = [];
    for (const r of rows) {
      if (!r || !r.slug) continue;
      categories.push({
        slug: String(r.slug),
        nameFa: r.name_fa ? String(r.name_fa) : String(r.slug),
        nameEn: r.name_en ? String(r.name_en) : null
      });
    }
    return appApiJson({ ok: true, categories: categories });
  } catch (e) {
    return lawyersError("lawyers/categories", e);
  }
}

// ─────────────────────────── route registration ───────────────────────────
marketplaceRegister("POST /api/v1/lawyers/list", lawyersHandleList);
marketplaceRegister("POST /api/v1/lawyers/get", lawyersHandleGet);
marketplaceRegister("POST /api/v1/lawyers/me", lawyersHandleMe);
marketplaceRegister("POST /api/v1/lawyers/save", lawyersHandleSave);
marketplaceRegister("POST /api/v1/lawyers/apply", lawyersHandleApply);
marketplaceRegister("POST /api/v1/lawyers/categories", lawyersHandleCategories);
