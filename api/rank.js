// Vercel Serverless Function - api/rank.js
// 사용: /api/rank?placeUrl=<플레이스 URL>&keyword=<검색어(선택)>
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const MAX_RANK = 100;          // 여기까지만 찾고 "100위 밖" 처리
const PAGE_SIZE = 50;
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();       // 인스턴스 단위 메모리 캐시 (콜드스타트 시 초기화됨)

// ⚠️ 비공식 내부 API라 스키마가 바뀌면 이 두 함수만 고치면 됨
function buildBody(type, keyword, x, y, start) {
  if (type === "restaurant") {
    return [{
      operationName: "getRestaurants",
      variables: {
        restaurantListInput: { query: keyword, x, y, start, display: PAGE_SIZE, deviceType: "mobile", isPcmap: false },
        isNmap: false, isBounding: false
      },
      query: `query getRestaurants($restaurantListInput: RestaurantListInput) {
        restaurants: restaurantList(input: $restaurantListInput) { total items { id name __typename } }
      }`
    }];
  }
  return [{
    operationName: "getPlacesList",
    variables: { input: { query: keyword, x, y, start, display: PAGE_SIZE, deviceType: "mobile" } },
    query: `query getPlacesList($input: PlacesInput) {
      businesses: places(input: $input) { total items { id name __typename } }
    }`
  }];
}
function pickItems(json) {
  const d = Array.isArray(json) ? json[0] : json;
  const root = d && d.data;
  if (!root) return null;
  const list = root.restaurants || root.businesses || root.places;
  return list && Array.isArray(list.items) ? list : null;
}
const isAd = (it) => /ad/i.test(it.__typename || "") || it.isAdItem === true || it.isAd === true;

async function resolveUrl(raw) {
  if (!raw.includes("naver.me")) return raw;
  try {
    const r = await fetch(raw, { redirect: "manual", headers: { "User-Agent": UA } });
    const loc = r.headers.get("location");
    if (loc) return loc;
    const f = await fetch(raw, { redirect: "follow", headers: { "User-Agent": UA } });
    return f.url || raw;
  } catch (e) { return raw; }
}

function extractId(url) {
  const m = url.match(/(?:place|restaurant|hairshop|hospital|accommodation|cafe|entry\/place)\/(\d+)/i)
         || url.match(/[?&]id=(\d{6,11})/)
         || url.match(/\/(\d{6,11})(?:[/?#]|$)/);
  return m ? m[1] : "";
}

async function getPlaceInfo(id) {
  const res = await fetch(`https://m.place.naver.com/place/${id}/home`, {
    headers: { "User-Agent": UA, "Referer": "https://m.map.naver.com/", "Accept-Language": "ko-KR,ko;q=0.9" }
  });
  if (!res.ok) throw new Error("PLACE_PAGE_" + res.status);
  const html = await res.text();

  const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  const nm = html.match(/"name":"([^"]+)"/);
  const name = ((og && og[1]) || (nm && nm[1]) || "내 매장").replace(/\s*:\s*네이버.*$/, "").trim();

  const x = (html.match(/"x":"(1[23]\d\.\d+)"/) || [])[1] || "";
  const y = (html.match(/"y":"(3[3-9]\.\d+)"/) || [])[1] || "";

  const addr = (html.match(/"roadAddress":"([^"]+)"/) || html.match(/"address":"([^"]+)"/) || [])[1] || "";
  const cat = ((html.match(/"category":"([^"]+)"/) || html.match(/"categoryName":"([^"]+)"/) || [])[1] || "")
    .split(",")[0].split(">").pop().trim();

  // 기본 키워드: 시/구 + 업종 (사용자가 입력하면 무시됨)
  const p = addr.split(" ");
  let region = (p[0] || "").replace(/(특별|광역|특별자치)?시$/, "").replace(/특별자치도$/, "").replace(/도$/, "");
  if (p[1] && /[구군시]$/.test(p[1])) region += " " + p[1];
  const defaultKeyword = [region, cat].filter(Boolean).join(" ") || name;

  const isFood = /음식|식당|카페|디저트|술집|베이커리|한식|양식|중식|일식|분식|치킨|커피/.test(html.slice(0, 200000)) && /카페|음식|식당|베이커리|한식|양식|중식|일식|분식|치킨|술집|디저트/.test(cat + html.match(/"businessType":"[^"]*"/)?.[0]);
  return { name, x, y, defaultKeyword, type: isFood ? "restaurant" : "place" };
}

async function fetchPage(info, keyword, start) {
  const res = await fetch("https://pcmap-api.place.naver.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "Origin": "https://pcmap.place.naver.com",
      "Referer": `https://pcmap.place.naver.com/${info.type}/list?query=${encodeURIComponent(keyword)}`,
      "Accept-Language": "ko-KR,ko;q=0.9"
    },
    body: JSON.stringify(buildBody(info.type, keyword, info.x, info.y, start))
  });
  if (!res.ok) throw new Error("GRAPHQL_" + res.status);
  const list = pickItems(await res.json());
  if (!list) throw new Error("GRAPHQL_SCHEMA");
  return list;
}

async function findRank(info, placeId, keyword) {
  let organic = 0, start = 1;
  while (organic < MAX_RANK) {
    const list = await fetchPage(info, keyword, start);
    if (!list.items.length) break;
    for (const it of list.items) {
      if (isAd(it)) continue;
      organic++;
      if (String(it.id) === placeId) return { rank: organic, total: list.total };
    }
    if (start + PAGE_SIZE > (list.total || 0)) break;
    start += PAGE_SIZE;
  }
  return { rank: null, total: null };
}

export default async function handler(req, res) {
  const { placeUrl, keyword: kwInput } = req.query;
  if (!placeUrl) return res.status(400).json({ error: "플레이스 URL을 입력해주세요." });

  const resolved = await resolveUrl(String(placeUrl).trim());
  const placeId = extractId(resolved);
  if (!placeId) return res.status(400).json({ error: "올바른 네이버 플레이스 주소가 아닙니다." });

  const kw = (kwInput || "").trim();
  const key = placeId + "|" + kw;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return res.status(200).json(hit.data);

  try {
    const info = await getPlaceInfo(placeId);
    if (!info.x || !info.y) return res.status(200).json({ error: "매장 좌표를 읽지 못했어요. 잠시 후 다시 시도해 주세요." });

    const keyword = kw || info.defaultKeyword;
    const { rank, total } = await findRank(info, placeId, keyword);

    const data = {
      name: info.name,
      keyword,
      keywordAuto: !kw,
      rankNum: rank,
      rank: rank ? `${rank}위` : `${MAX_RANK}위 밖`,
      total
    };
    cache.set(key, { t: Date.now(), data });
    return res.status(200).json(data);
  } catch (e) {
    // 가짜 점수 대신 정직하게 실패 응답
    console.error("rank error:", e.message);
    return res.status(200).json({ error: "지금은 순위를 조회할 수 없어요. 잠시 후 다시 시도해 주세요." });
  }
}
