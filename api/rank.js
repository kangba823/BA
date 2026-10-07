// Vercel Serverless Function (Node.js)
export default async function handler(req, res) {
  const { placeUrl } = req.query;
  if (!placeUrl) {
    return res.status(400).json({ error: "플레이스 URL을 입력해주세요." });
  }

  try {
    let placeId = "";

    // 1. 단축 링크(naver.me) 리다이렉트 추적
    if (placeUrl.includes("naver.me")) {
      const redirectRes = await fetch(placeUrl, { redirect: "follow" });
      const finalUrl = redirectRes.url || "";
      const match = finalUrl.match(/place\/(\d+)/);
      if (match) placeId = match[1];
    } else {
      const match = placeUrl.match(/place\/(\d+)/);
      if (match) placeId = match[1];
    }

    if (!placeId) {
      return res.status(400).json({ error: "올바른 네이버 플레이스 주소가 아닙니다." });
    }

    // 2. 플레이스 상세 정보 조회 (모바일 API)
    const detailUrl = `https://m.place.naver.com/place/${placeId}/home`;
    const detailRes = await fetch(detailUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
      }
    });
    const htmlText = await detailRes.text();

    // 상호명 추출
    const titleMatch = htmlText.match(/<title>(.*?)<\/title>/);
    const storeName = titleMatch ? titleMatch[1].split(":")[0].trim() : "내 매장";

    // 3. 검색 쿼리 구성 (상호명 기준)
    const searchUrl = `https://m.map.naver.com/search2/getSearchList.naver?query=${encodeURIComponent(storeName)}&type=SITE&page=1`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
      }
    });
    const searchData = await searchRes.json();
    const siteList = searchData?.result?.site?.list || [];

    const rankIdx = siteList.findIndex(item => item.id === placeId);
    const currentRank = rankIdx !== -1 ? `${rankIdx + 1}위` : "상위 30위 밖";

    // 4. 모의 지수 환산
    const score = rankIdx !== -1 ? Math.max(60, 100 - (rankIdx * 5)) : 45;

    return res.status(200).json({
      name: storeName,
      keyword: storeName,
      rank: currentRank,
      score: score
    });

  } catch (error) {
    return res.status(500).json({ error: "네이버 데이터 조회 중 일시적 오류가 발생했습니다." });
  }
}
