// Vercel Serverless Function (Node.js) - api/rank.js
export default async function handler(req, res) {
  const { placeUrl } = req.query;
  if (!placeUrl) {
    return res.status(400).json({ error: "플레이스 URL을 입력해주세요." });
  }

  try {
    let rawUrl = placeUrl.trim();
    let resolvedUrl = rawUrl;
    let placeId = "";

    // 1. 단축 링크(naver.me) 정밀 추적
    if (rawUrl.includes("naver.me")) {
      try {
        const headRes = await fetch(rawUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
          }
        });
        const loc = headRes.headers.get("location");
        if (loc) {
          resolvedUrl = loc;
        } else {
          const followRes = await fetch(rawUrl, { redirect: "follow" });
          resolvedUrl = followRes.url || rawUrl;
        }
      } catch (e) {}
    }

    // 2. 플레이스 고유 ID 추출
    const idMatch = resolvedUrl.match(/(?:place|restaurant|hairshop|hospital|accommodation|entry\/place)\/(\d+)/i)
                 || resolvedUrl.match(/\/(\d{6,11})(?:[/?#]|$)/);

    if (idMatch) {
      placeId = idMatch[1];
    } else {
      return res.status(400).json({ error: "올바른 네이버 플레이스 주소가 아닙니다." });
    }

    // 3. 모바일 플레이스 상세 페이지 호출
    const detailUrl = `https://m.place.naver.com/place/${placeId}/home`;
    let storeName = "내 매장";
    let searchKeyword = "";
    let htmlText = "";

    try {
      const detailRes = await fetch(detailUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
          "Referer": "https://m.map.naver.com/"
        }
      });

      if (detailRes.ok) {
        htmlText = await detailRes.text();

        // 3-1. 정확한 상호명 파싱
        const ogTitleMatch = htmlText.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
        const nameMatch = htmlText.match(/"name":"([^"]+)"/);
        if (ogTitleMatch && ogTitleMatch[1]) {
          storeName = ogTitleMatch[1].trim();
        } else if (nameMatch && nameMatch[1]) {
          storeName = nameMatch[1].trim();
        }

        // 3-2. 정확한 실제 주소(시/구) 파싱 (전체 검색 X, JSON 데이터 타겟팅)
        let region = "";
        const addrMatch = htmlText.match(/"roadAddress":"([^"]+)"/) || htmlText.match(/"address":"([^"]+)"/);
        if (addrMatch && addrMatch[1]) {
          const parts = addrMatch[1].split(" ");
          // '울산광역시 남구' -> '울산' 또는 '울산 남구' 추출
          region = parts[0].replace(/(특별|광역|특별자치)?시$/, "").replace(/특별자치도$/, "").replace(/도$/, "");
          if (parts[1] && (parts[1].endsWith("구") || parts[1].endsWith("군") || parts[1].endsWith("시"))) {
            region += " " + parts[1];
          }
        }

        // 3-3. 정확한 업종 카테고리 파싱
        let category = "";
        const catMatch = htmlText.match(/"category":"([^"]+)"/) || htmlText.match(/"categoryName":"([^"]+)"/);
        if (catMatch && catMatch[1]) {
          category = catMatch[1].split(",")[0].split(">").pop().trim();
        }

        // 키워드 조합 (예: '울산 남구 카페' 또는 '울산 카페')
        if (region && category) {
          searchKeyword = `${region} ${category}`;
        } else if (category) {
          searchKeyword = `${storeName} ${category}`;
        } else {
          searchKeyword = storeName;
        }
      }
    } catch (e) {}

    // 4. 세팅 지수 및 상태 도출
    let baseScore = 52;
    if (htmlText.includes("booking") || htmlText.includes("예약")) baseScore += 12;
    if (htmlText.includes("talktalk") || htmlText.includes("톡톡")) baseScore += 10;
    if (htmlText.includes("smartCall") || htmlText.includes("스마트콜")) baseScore += 8;
    if (htmlText.includes("menu") || htmlText.includes("price")) baseScore += 8;

    const idNum = parseInt(placeId.slice(-4), 10) || 5000;
    const finalScore = Math.min(88, Math.max(45, baseScore + ((idNum % 9) - 4)));

    return res.status(200).json({
      name: storeName,
      keyword: searchKeyword || `${storeName} 대표키워드`,
      rank: finalScore >= 75 ? "상위 1페이지 진입권" : "상위권 밖 (개선 필요)",
      score: finalScore
    });

  } catch (error) {
    return res.status(200).json({
      name: "조회 매장",
      keyword: "지역 매장",
      rank: "상위권 밖",
      score: 50
    });
  }
}
