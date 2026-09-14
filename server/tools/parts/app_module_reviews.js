// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Post-consultation client reviews for the Vakil AI marketplace:
//             the public review list on a lawyer's profile (with count +
//             average), the "my review for this consultation" read, and the
//             strictly-gated submit. Trust property: a review can ONLY exist
//             as the outcome of a COMPLETED consultation that its own client
//             wrote, so a rating on a lawyer page is always earned history.
// OWNER     — Wave-2 lane A — reviews.
// CONSUMES  — appApiJson/appApiErr/appApiVerifyToken (app_module_head.js);
//             marketplaceRegister/marketplaceEnsureTables/marketplaceRequireToken/
//             marketplaceRateLimit/marketplaceNow/marketplaceNewId
//             (app_module_common.js);
//             consultationLoad/consultationMembership (app_module_consultations.js
//             — Agent 7's documented seam; this file NEVER re-implements
//             membership and never writes consultations); app_module_schema.js
//             DDL for reviews + consultations + app_accounts (no DDL here).
// PROVIDES  — POST /api/v1/reviews/lawyer  → LawyerReviewsResponse (public)
//             POST /api/v1/reviews/mine    → LawyerReviewsResponse (client only)
//             POST /api/v1/reviews/submit  → LawyerReviewsResponse (client only)
//             reviewEnsureLawyerContext(env, consultationId, uid)
//                   → {row, membership?, err?} — the ONE membership/eligibility
//                     gate shared by /mine and /submit (name pinned by the
//                     coordinator in check_app_worker.cjs REQUIRED).
//             Response JSON keys match src/VakilAI.Application/Contracts/
//             MarketplaceContracts.cs (LawyerReviewsResponse / ReviewDto):
//             {ok, lawyerUserId, count, average, reviews[], code?, message?}
//             ReviewDto: {id, consultationId, lawyerUserId, reviewerName,
//                         rating, comment, createdAt}.
//             Semantics of count/average:
//               /lawyer + /submit → the LAWYER'S whole book (all their reviews)
//               /mine             → the caller's own slot (0 or 1 review)
//             average is Math.round(x*10)/10 and NULL when count===0 — never a
//             fabricated 0.0 that would read as "one-star average".
// INVARIANTS— 1) Strict eligibility, server-side only: the writer must be the
//                consultation's CLIENT (consultationMembership on the loaded
//                row vs the verified token uid), and the consultation must be
//                COMPLETED. Anyone else — the lawyer of that consultation, an
//                admin, a stranger — cannot create a review for it.
//             2) Uniform 404 for "no such consultation" AND "you are not a
//                participant" (audit L1 pattern from Agent 7): consultation ids
//                are time-ordered, so a distinct 403 would let any token
//                enumerate other people's consultations.
//             3) The public list is derived through the consultations JOIN
//                (c.lawyer_user_id = target, c.status = 'COMPLETED'), so a
//                forged consultation_id or a mis-stamped reviews.lawyer_user_id
//                can never attach a review to a lawyer who never served it.
//             4) One review per consultation, enforced by reviews.consultation_id
//                UNIQUE: pre-check (ALREADY_REVIEWED) plus a catch on the
//                constraint for the concurrent race, which then re-reads and
//                reports the winner — no row is ever lost or doubled.
//             5) NO edit/delete in V1 (see EXTEND). A submitted review is
//                immutable history.
//             6) No fabricated data anywhere: reviews is never seeded, an
//                empty book answers {ok:true, reviews:[], count:0, average:null},
//                reviewerName comes from a real app_accounts display_name, and
//                every timestamp is marketplaceNow().
//             7) All SQL uses D1 bind parameters; no user value is ever
//                interpolated into SQL text.
// EXTEND    — V2 candidates, deliberately NOT built in V1: (a) edit/delete of a
//                review by its author + an admin moderation/removal route
//                (append-only until there is a policy + audit trail for it);
//                (b) a reply from the lawyer (reviews.reply_*); (c) verified
//                "response time" / rating breakdown per specialty; (d) hiding
//                reviews authored by suspended/deleted accounts (today the
//                review of a completed consultation stays on the record);
//                (e) a reviews_listed flag on the consultation so the UI can
//                stop prompting. New columns go through app_module_schema.js +
//                schema.marketplace.sql together, then this file's projection.
// ═══════════════════════════════════════════════════════════════════════════

/* eslint-disable no-undef */

// ─────────────────────────── constants ───────────────────────────
const REVIEWS_PAGE_MAX = 50;      // hard row cap on the public list (newest first)
const REVIEWS_COMMENT_MAX = 1000; // chars, after trim
const REVIEWS_SUBMIT_LIMIT_PER_MIN = 10;

const REVIEWS_MSG_NOT_FOUND = "مشاوره‌ای با این شناسه یافت نشد.";
const REVIEWS_MSG_NOT_COMPLETED = "امکان ثبت نظر فقط پس از پایان مشاوره وجود دارد.";
const REVIEWS_MSG_ALREADY = "شما برای این مشاوره قبلاً نظر ثبت کرده‌اید؛ نظرها قابل ویرایش نیستند.";
const REVIEWS_MSG_NOT_CLIENT = "تنها کارفرمای یک مشاوره می‌تواند دربارهٔ آن نظر ثبت کند.";
const REVIEWS_MSG_INTERNAL = "مشکلی در سرور پیش آمد. لطفاً کمی بعد تلاش کنید.";

/**
 * Fixed projection shared by every review read. reviewerName comes from the
 * consultation's client account (COALESCE: reviews.client_user_id is authoritative,
 * the consultation is the fallback) so a review always names a real person and
 * never a self-declared display name passed in the request body.
 */
const REVIEWS_SELECT_COLUMNS =
  "r.id, r.consultation_id, r.lawyer_user_id, r.client_user_id, r.rating, r.comment, r.created_at, " +
  "aa.display_name AS reviewer_name";

const REVIEWS_SELECT_FROM =
  "FROM reviews r " +
  "JOIN consultations c ON c.id = r.consultation_id " +
  "LEFT JOIN app_accounts aa ON aa.user_id = COALESCE(r.client_user_id, c.client_user_id) ";

// ─────────────────────────── private helpers (prefix: review*) ───────────────────────────

/** Uniform 500 for D1/unexpected failures — logged, Persian message, never thrown. */
function reviewsError(route, err) {
  console.error(`[${route}] failed:`, (err && (err.stack || err.message)) || err);
  return appApiErr("INTERNAL", REVIEWS_MSG_INTERNAL, 500);
}

/** SQLite hosts may hand back INTEGER cells as bigint on some runtimes. */
function reviewsNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** D1 surfaces SQLite errors as plain Errors carrying the SQL text — UNIQUE probe. */
function reviewsIsUniqueViolation(e) {
  return /UNIQUE constraint failed|constraint failed|ON CONFLICT/i.test(
    String((e && (e.message || e.error)) || e || ""));
}

/** One-decimal rounding for the aggregate shown next to the star widget. */
function reviewsRound1(x) {
  return Math.round(x * 10) / 10;
}

/** Row (REVIEWS_SELECT_COLUMNS shape) → ReviewDto, keys fixed by MarketplaceContracts.cs. */
function reviewsDto(row) {
  return {
    id: reviewsNum(row.id),
    consultationId: reviewsNum(row.consultation_id),
    lawyerUserId: reviewsNum(row.lawyer_user_id),
    reviewerName: row.reviewer_name ? String(row.reviewer_name) : null,
    rating: reviewsNum(row.rating),
    comment: row.comment == null || row.comment === "" ? null : String(row.comment),
    createdAt: reviewsNum(row.created_at) || 0
  };
}

/**
 * The lawyer's whole book: {count, average}. average is null when count is 0
 * (INVARIANT: no fake 0.0). Reads only COMPLETED consultations so a row that
 * somehow predates the eligibility rule cannot inflate a profile.
 */
async function reviewsAggregateForLawyer(env, lawyerUserId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n, AVG(r.rating) AS a " + REVIEWS_SELECT_FROM +
    "WHERE c.lawyer_user_id = ? AND (r.lawyer_user_id IS NULL OR r.lawyer_user_id = ?) " +
    "AND c.status = 'COMPLETED'"
  ).bind(lawyerUserId, lawyerUserId).first();
  const count = Math.max(0, reviewsNum(row && row.n) || 0);
  const avg = row ? reviewsNum(row.a) : null;
  return { count: count, average: count > 0 && avg !== null ? reviewsRound1(avg) : null };
}

/** The caller's own review slot for one consultation (≤1 row by the UNIQUE index). */
async function reviewsLoadForConsultation(env, consultationId) {
  const row = await env.DB.prepare(
    `SELECT ${REVIEWS_SELECT_COLUMNS} ${REVIEWS_SELECT_FROM} WHERE r.consultation_id = ? LIMIT 1`
  ).bind(consultationId).first();
  return row || null;
}

/**
 * THE eligibility gate for /mine and /submit, in one place (coordinator-pinned name).
 * @param {object} env   worker env (needs env.DB)
 * @param {*} consultationId raw request value — coerced here, never trusted
 * @param {*} uid          verified token payload uid (server-side truth ONLY)
 * @returns {Promise<{row: object|null, membership?: string, err?: Response}>}
 *   err is set when the caller may not act:
 *     NOT_FOUND 404 — no such consultation, or the caller is not a participant
 *                   (same answer either way, INVARIANT 2)
 *     FORBIDDEN 403 — a participant, but not the consultation's CLIENT
 */
async function reviewEnsureLawyerContext(env, consultationId, uid) {
  const cid = reviewsNum(consultationId);
  if (cid === null) {
    return { row: null, err: appApiErr("VALIDATION", "شناسه مشاوره ارسال نشده یا معتبر نیست.", 400) };
  }
  const row = await consultationLoad(env, cid);
  if (!row) return { row: null, err: appApiErr("NOT_FOUND", REVIEWS_MSG_NOT_FOUND, 404) };
  const membership = consultationMembership(row, uid);
  if (!membership) {
    return { row: null, err: appApiErr("NOT_FOUND", REVIEWS_MSG_NOT_FOUND, 404) };
  }
  if (membership !== "client") {
    return { row, membership, err: appApiErr("FORBIDDEN", REVIEWS_MSG_NOT_CLIENT, 403) };
  }
  return { row, membership };
}

/**
 * Shared success envelope (LawyerReviewsResponse). `aggregate` overrides
 * count/average when the caller wants the lawyer's whole book while returning a
 * narrower `reviews` page (e.g. /submit echoes one new row + fresh stats).
 */
function reviewsResponse(lawyerUserId, reviews, aggregate) {
  const list = Array.isArray(reviews) ? reviews : [];
  const agg = aggregate || {};
  const count = Number.isFinite(Number(agg.count)) ? Number(agg.count) : list.length;
  let average = agg.average;
  if (average === undefined) {
    if (count === 0) average = null;
    else {
      const sum = list.reduce((acc, r) => acc + (Number(r.rating) || 0), 0);
      average = reviewsRound1(sum / (agg.count || list.length || 1));
    }
  }
  return appApiJson({
    ok: true,
    lawyerUserId: reviewsNum(lawyerUserId),
    count: count,
    average: average === undefined ? null : average,
    reviews: list
  });
}

/** Handler-side table gate: a schema failure must answer 500, never crash the route. */
async function reviewsPrepare(env) {
  try {
    await marketplaceEnsureTables(env);
    return null;
  } catch (e) {
    console.error("reviewsPrepare error:", e && e.message);
    return appApiErr("INTERNAL", REVIEWS_MSG_INTERNAL, 500);
  }
}

// ─────────────────────────── POST /api/v1/reviews/lawyer ───────────────────────────

/**
 * POST /api/v1/reviews/lawyer — PUBLIC (no token): the review book of one lawyer.
 * Body: {lawyerUserId}
 * → {ok, lawyerUserId, count, average, reviews[ReviewDto]} newest first, ≤50 rows;
 *   count/average cover the lawyer's ENTIRE book, not just the page.
 * An unknown/anonymous/pending lawyer answers the honest empty state
 * (count 0 / average null) — the existence of a lawyer is /lawyers/get's job and
 * this route must not 404-probe the accounts table.
 * Codes: VALIDATION 400 (bad id), INTERNAL 500.
 */
async function reviewsHandleList(env, ctx, body) {
  const prep = await reviewsPrepare(env);
  if (prep) return prep;
  try {
    const lawyerUserId = reviewsNum(body && body.lawyerUserId);
    if (lawyerUserId === null) {
      return appApiErr("VALIDATION", "شناسه وکیل ارسال نشده یا معتبر نیست.", 400);
    }

    const agg = await reviewsAggregateForLawyer(env, lawyerUserId);

    if (agg.count === 0) {
      return appApiJson({
        ok: true, lawyerUserId: lawyerUserId, count: 0, average: null, reviews: [],
        message: "هنوز برای این وکیل نظری ثبت نشده است؛ نظرها تنها پس از پایان مشاورهٔ مشتریان ثبت می‌شوند."
      });
    }

    const res = await env.DB.prepare(
      `SELECT ${REVIEWS_SELECT_COLUMNS} ${REVIEWS_SELECT_FROM} ` +
      "WHERE c.lawyer_user_id = ? AND (r.lawyer_user_id IS NULL OR r.lawyer_user_id = ?) " +
      "AND c.status = 'COMPLETED' " +
      `ORDER BY r.created_at IS NULL, r.created_at DESC, r.id DESC LIMIT ${REVIEWS_PAGE_MAX}`
    ).bind(lawyerUserId, lawyerUserId).all();
    const rows = res && Array.isArray(res.results) ? res.results : [];
    return reviewsResponse(lawyerUserId, rows.map(reviewsDto), agg);
  } catch (e) {
    return reviewsError("reviews/lawyer", e);
  }
}

// ─────────────────────────── POST /api/v1/reviews/mine ───────────────────────────

/**
 * POST /api/v1/reviews/mine — the caller's own review for one consultation
 * (drives the "امکان ثبت نظر دارید / نظر شما ثبت شده" UI state).
 * Body: {token, consultationId}
 * Caller must be the consultation's CLIENT.
 * → {ok, lawyerUserId, count, average, reviews[0..1]} — count/average describe
 *   the caller's slot only (0 or 1), never the lawyer's book.
 * Codes: UNAUTHORIZED 401, VALIDATION 400, NOT_FOUND 404 (missing or
 *        non-participant), FORBIDDEN 403 (participant but not the client), INTERNAL 500.
 */
async function reviewsHandleMine(env, ctx, body) {
  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return auth.err;
  const prep = await reviewsPrepare(env);
  if (prep) return prep;
  try {
    const gate = await reviewEnsureLawyerContext(env, body && body.consultationId, auth.payload.uid);
    if (gate.err) return gate.err;

    const existing = await reviewsLoadForConsultation(env, reviewsNum(gate.row.id));
    const list = existing ? [reviewsDto(existing)] : [];
    const lawyerUserId = reviewsNum(gate.row.lawyer_user_id);
    return reviewsResponse(lawyerUserId, list,
      { count: list.length, average: list.length ? reviewsRound1(Number(list[0].rating)) : null });
  } catch (e) {
    return reviewsError("reviews/mine", e);
  }
}

// ─────────────────────────── POST /api/v1/reviews/submit ───────────────────────────

/**
 * POST /api/v1/reviews/submit — the consultation's client rates a finished session.
 * Body: {token, consultationId, rating (1..5 int), comment? (≤1000, may be empty)}
 * Gates, in order: valid session → rate limit 10/min per user → well-formed
 * consultationId → caller IS the client → status COMPLETED → rating/comment
 * shape → one-per-consultation (pre-check + UNIQUE catch).
 * → LawyerReviewsResponse with the lawyer's FRESH count + average (so the UI
 *   updates without a second round-trip) and the new review in reviews[].
 * Codes: UNAUTHORIZED 401, VALIDATION 400, NOT_FOUND 404, FORBIDDEN 403,
 *        CONSULTATION_NOT_COMPLETED 409, ALREADY_REVIEWED 409, RATE_LIMITED 429,
 *        INTERNAL 500.
 */
async function reviewsHandleSubmit(env, ctx, body) {
  const auth = await marketplaceRequireToken(env, body);
  if (auth.err) return auth.err;
  const prep = await reviewsPrepare(env);
  if (prep) return prep;
  try {
    const uid = reviewsNum(auth.payload.uid);
    const req = body || {};

    // Throttle first (audit: the limiter must also cover probing attempts),
    // then eligibility, then the write.
    if (!await marketplaceRateLimit(env, "review-submit:" + uid, REVIEWS_SUBMIT_LIMIT_PER_MIN, 60000)) {
      return appApiErr("RATE_LIMITED", "ثبت نظر بسیار سریع است؛ چند لحظه دیگر تلاش کنید.", 429);
    }

    const gate = await reviewEnsureLawyerContext(env, req.consultationId, auth.payload.uid);
    if (gate.err) return gate.err;
    const consultationId = reviewsNum(gate.row.id);
    const lawyerUserId = reviewsNum(gate.row.lawyer_user_id);

    if (String(gate.row.status || "") !== "COMPLETED") {
      return appApiErr("CONSULTATION_NOT_COMPLETED", REVIEWS_MSG_NOT_COMPLETED, 409);
    }

    const rawRating = req.rating;
    const rating = typeof rawRating === "number" || typeof rawRating === "string"
      ? Number(rawRating) : NaN;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return appApiErr("VALIDATION", "امتیاز باید عددی صحیح بین ۱ تا ۵ باشد.", 400);
    }

    let comment = null;
    if (req.comment !== null && req.comment !== undefined && req.comment !== "") {
      comment = (typeof req.comment === "string" ? req.comment : String(req.comment)).trim();
      if (comment.length > REVIEWS_COMMENT_MAX) {
        return appApiErr("VALIDATION",
          "متن نظر بیش از حد بلند است (حداکثر " + REVIEWS_COMMENT_MAX + " نویسه).", 400);
      }
      if (comment === "") comment = null; // empty means "no comment", stored NULL
    }

    // One review per consultation: reviews.consultation_id is UNIQUE.
    const prior = await reviewsLoadForConsultation(env, consultationId);
    if (prior) {
      return appApiJson({
        ok: false, code: "ALREADY_REVIEWED", message: REVIEWS_MSG_ALREADY,
        lawyerUserId: lawyerUserId, count: 1, average: reviewsRound1(Number(prior.rating) || 0),
        reviews: [reviewsDto(prior)]
      }, 409);
    }

    const now = marketplaceNow();
    const id = marketplaceNewId();
    try {
      await env.DB.prepare(
        "INSERT INTO reviews (id, consultation_id, client_user_id, lawyer_user_id, rating, comment, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, consultationId, uid, lawyerUserId, rating, comment, now).run();
    } catch (e) {
      // The UNIQUE index is the source of truth for a concurrent double submit.
      if (reviewsIsUniqueViolation(e)) {
        const winner = await reviewsLoadForConsultation(env, consultationId);
        return appApiJson({
          ok: false, code: "ALREADY_REVIEWED", message: REVIEWS_MSG_ALREADY,
          lawyerUserId: lawyerUserId,
          count: winner ? 1 : 0,
          average: winner ? reviewsRound1(Number(winner.rating) || 0) : null,
          reviews: winner ? [reviewsDto(winner)] : []
        }, 409);
      }
      console.error("reviewsHandleSubmit insert error:", e && e.message);
      return appApiErr("INTERNAL", "نظر شما ثبت نشد. لطفاً مجدداً تلاش کنید.", 500);
    }

    const created = await reviewsLoadForConsultation(env, consultationId);
    const agg = await reviewsAggregateForLawyer(env, lawyerUserId);
    const dto = created ? reviewsDto(created) : {
      id: id, consultationId: consultationId, lawyerUserId: lawyerUserId,
      reviewerName: (auth.account && auth.account.display_name) || null,
      rating: rating, comment: comment, createdAt: now
    };
    return appApiJson({
      ok: true,
      lawyerUserId: lawyerUserId,
      count: agg.count,
      average: agg.average,
      reviews: [dto],
      message: "نظر شما ثبت شد. از اینکه به بهبود دفترچه وکلا کمک کردید سپاسگزاریم."
    });
  } catch (e) {
    return reviewsError("reviews/submit", e);
  }
}

// ─────────────────────────── route registration ───────────────────────────
// The only top-level side effects in this file (spec §5).
marketplaceRegister("POST /api/v1/reviews/lawyer", reviewsHandleList);
marketplaceRegister("POST /api/v1/reviews/mine", reviewsHandleMine);
marketplaceRegister("POST /api/v1/reviews/submit", reviewsHandleSubmit);
