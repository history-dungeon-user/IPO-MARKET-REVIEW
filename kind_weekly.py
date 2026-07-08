# -*- coding: utf-8 -*-
"""
KIND IPO 예비심사 현황 - 주간 통합 자동화 (kind_weekly.py)
=============================================================
매주 1회 이 파일만 실행하면 아래가 자동으로 처리됩니다.

  1) KIND 목록 수집 (시장구분·bizProcNo 포함)
  2) 분류: 신청(청구서 접수) / 승인(심사 승인) / 철회·미승인
  3) 누적 정본(kind_master.json) 증분 갱신 + 상태전이 기록
  4) 재무 미보유 '신규 건만' 상세 수집 (검증된 파서 v2)
     - 동일사 복수청구 구분: (회사명+청구일) 키 매핑
     - 라벨 정확 매칭 (매출액(수익)/순이익/자기자본/업종/국적)
     - 단위 자동 판별 (백만원 / USD)
  5) 3표 구성 후 index.html 재생성

산출물 (같은 폴더):
  - index.html        : 공개용 웹페이지 (매 실행 시 갱신)
  - kind_master.json  : 누적 정본 (삭제 금지)
  - kind_findata.json : 재무 데이터 누적 저장소 (삭제 금지)
  - kind_changes.log  : 변경 이력

규칙 (확정본):
  - 심사중 = 심사결과 '청구서 접수'
  - 승인·철회·미승인 = 당해 연도(결과 확정일 기준) 누적, 재상장 제외
  - 재무 = 청구일 직전 사업연도 · 별도/개별 · 백만원 (외국기업 USD 표기)

사용법:  python kind_weekly.py   (또는 더블클릭)
사전준비: pip install requests beautifulsoup4 lxml
"""

import os, sys, re, json, datetime as dt

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("[오류] pip install requests beautifulsoup4 lxml  먼저 실행하세요.")
    input("\nEnter 키로 종료..."); sys.exit(1)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MASTER   = os.path.join(BASE_DIR, "kind_master.json")
FINDATA  = os.path.join(BASE_DIR, "kind_findata.json")
SITE     = os.path.join(BASE_DIR, "index.html")
LOG      = os.path.join(BASE_DIR, "kind_changes.log")

URL     = "https://kind.krx.co.kr/listinvstg/listinvstgcom.do"
REFERER = URL + "?method=searchListInvstgCorpMain"
YEAR    = str(dt.date.today().year)
TODAY   = dt.date.today().isoformat()

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": REFERER, "Origin": "https://kind.krx.co.kr",
    "X-Requested-With": "XMLHttpRequest",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
}

# ══════════════ 검증된 시드 재무 (2026-07-07 기준 76건) ══════════════
# key = "정규화회사명|청구일"  /  값 = 청구일 직전 사업연도 재무 (검증 완료)
SEED_FIN = {
"진코스텍|2026-07-06": {
"매출액": "48,646",
"순이익": "6,017",
"자기자본": "18,795",
"업종": "기타 화학제품 제조업",
"단위": "백만원",
"유가": ""
},
"엠디에스코리아|2026-07-03": {
"매출액": "97,972",
"순이익": "6,512",
"자기자본": "53,818",
"업종": "기타 식품 제조업",
"단위": "백만원",
"유가": ""
},
"동승|2026-06-30": {
"매출액": "78,625",
"순이익": "14,525",
"자기자본": "5,438",
"업종": "부동산 임대 및 공급업",
"단위": "백만원",
"유가": ""
},
"셀트릭스|2026-06-30": {
"매출액": "16,976",
"순이익": "4,545",
"자기자본": "2,213",
"업종": "의료용품 및 기타 의약 관련제품 제조업",
"단위": "백만원",
"유가": ""
},
"에프엠더블유|2026-06-30": {
"매출액": "30,282",
"순이익": "4,762",
"자기자본": "32",
"업종": "기타 식품 제조업",
"단위": "백만원",
"유가": ""
},
"소노인터내셔널|2026-06-26": {
"매출액": "2,093,051",
"순이익": "-148,064",
"자기자본": "852,372",
"업종": "일반 및 생활 숙박시설 운영업",
"단위": "백만원",
"유가": "Y"
},
"싸이몬|2026-06-25": {
"매출액": "48,695",
"순이익": "15,714",
"자기자본": "61,761",
"업종": "측정, 시험, 항해, 제어 및 기타 정밀기기 제조업",
"단위": "백만원",
"유가": ""
},
"바이다|2026-06-23": {
"매출액": "14,432",
"순이익": "-3,951",
"자기자본": "15,108",
"업종": "전자부품 제조업",
"단위": "백만원",
"유가": ""
},
"럭스코|2026-06-19": {
"매출액": "67,976",
"순이익": "6,893",
"자기자본": "1,000",
"업종": "전동기, 발전기 및 전기 변환 · 공급 · 제어 장치 제조업",
"단위": "백만원",
"유가": ""
},
"아이알큐더스|2026-06-19": {
"매출액": "10,231",
"순이익": "-986",
"자기자본": "1,800",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"이에스티|2026-06-19": {
"매출액": "33,190",
"순이익": "2,966",
"자기자본": "4,325",
"업종": "특수 목적용 기계 제조업",
"단위": "백만원",
"유가": ""
},
"영광|2026-06-18": {
"매출액": "113,133",
"순이익": "10,328",
"자기자본": "3,052",
"업종": "구조용 금속제품, 탱크 및 증기발생기 제조업",
"단위": "백만원",
"유가": ""
},
"티앤이코리아|2026-06-17": {
"매출액": "22,339",
"순이익": "-7,091",
"자기자본": "481",
"업종": "일반 목적용 기계 제조업",
"단위": "백만원",
"유가": ""
},
"에스케이증권제14호스팩|2026-06-12": {
"매출액": "-",
"순이익": "-",
"자기자본": "17",
"업종": "기타 금융업",
"단위": "백만원",
"유가": ""
},
"케이비제34호스팩|2026-06-12": {
"매출액": "-",
"순이익": "-",
"자기자본": "21",
"업종": "기타 금융업",
"단위": "백만원",
"유가": ""
},
"한국제17호스팩|2026-06-12": {
"매출액": "-",
"순이익": "-",
"자기자본": "170",
"업종": "기타 금융업",
"단위": "백만원",
"유가": ""
},
"한화플러스제6호스팩|2026-06-12": {
"매출액": "-",
"순이익": "-",
"자기자본": "41",
"업종": "기타 금융업",
"단위": "백만원",
"유가": ""
},
"씨엔티테크|2026-06-11": {
"매출액": "27,015",
"순이익": "3,987",
"자기자본": "2,613",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"제이앤티지|2026-06-11": {
"매출액": "72,378",
"순이익": "9,904",
"자기자본": "6,743",
"업종": "전자부품 제조업",
"단위": "백만원",
"유가": ""
},
"엔에이치스팩34호|2026-05-29": {
"매출액": "-",
"순이익": "-",
"자기자본": "55",
"업종": "금융 지원 서비스업",
"단위": "백만원",
"유가": ""
},
"유캐스트|2026-05-29": {
"매출액": "5,934",
"순이익": "-3,557",
"자기자본": "1,881",
"업종": "통신 및 방송 장비 제조업",
"단위": "백만원",
"유가": ""
},
"인터엑스|2026-05-29": {
"매출액": "8,645",
"순이익": "-20,272",
"자기자본": "4,530",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"케이엠에프|2026-05-29": {
"매출액": "25,751",
"순이익": "11,463",
"자기자본": "642",
"업종": "기타 식품 제조업",
"단위": "백만원",
"유가": ""
},
"하나에어로다이내믹스|2026-05-29": {
"매출액": "33,286",
"순이익": "2,420",
"자기자본": "890",
"업종": "항공기,우주선 및 부품 제조업",
"단위": "백만원",
"유가": ""
},
"다비오|2026-05-28": {
"매출액": "9,251",
"순이익": "-3,473",
"자기자본": "300",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"삼홍아크튜리온|2026-05-28": {
"매출액": "26,162",
"순이익": "-10,314",
"자기자본": "6,369",
"업종": "구조용 금속제품, 탱크 및 증기발생기 제조업",
"단위": "백만원",
"유가": ""
},
"에이엘로봇|2026-05-22": {
"매출액": "14,985",
"순이익": "-21,891",
"자기자본": "129",
"업종": "산업용 로봇 제조업",
"단위": "백만원",
"유가": ""
},
"넥스트에어로스페이스|2026-05-21": {
"매출액": "12,084",
"순이익": "-17,270",
"자기자본": "6,158",
"업종": "유인 항공기, 항공우주선 및 보조장치 제조업",
"단위": "백만원",
"유가": ""
},
"래블업|2026-05-21": {
"매출액": "6,712",
"순이익": "-1,526",
"자기자본": "373",
"업종": "데이터베이스 및 온라인정보 제공업",
"단위": "백만원",
"유가": ""
},
"비앤비코리아|2026-05-21": {
"매출액": "141,169",
"순이익": "21,406",
"자기자본": "43,932",
"업종": "기타 화학제품 제조업",
"단위": "백만원",
"유가": ""
},
"에이엔에이치스트럭쳐|2026-05-21": {
"매출액": "19,784",
"순이익": "-4,296",
"자기자본": "24,561",
"업종": "건축기술, 엔지니어링 및 관련 기술 서비스업",
"단위": "백만원",
"유가": ""
},
"엘리스그룹|2026-05-19": {
"매출액": "39,513",
"순이익": "15,666",
"자기자본": "85,400",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"오토핸즈|2026-05-12": {
"매출액": "238,564",
"순이익": "6,047",
"자기자본": "6,129",
"업종": "자동차 판매업",
"단위": "백만원",
"유가": ""
},
"아이벡스메디칼시스템즈|2026-05-06": {
"매출액": "15,282",
"순이익": "-7,227",
"자기자본": "744",
"업종": "의료용 기기 제조업",
"단위": "백만원",
"유가": ""
},
"멜콘|2026-04-30": {
"매출액": "39,319",
"순이익": "4,739",
"자기자본": "1,250",
"업종": "특수 목적용 기계 제조업",
"단위": "백만원",
"유가": ""
},
"모비어스|2026-04-30": {
"매출액": "31,989",
"순이익": "-45,307",
"자기자본": "-96,707",
"업종": "컴퓨터 프로그래밍, 시스템 통합 및 관리업",
"단위": "백만원",
"유가": ""
},
"바로팜|2026-04-30": {
"매출액": "96,724",
"순이익": "-9,679",
"자기자본": "30,673",
"업종": "상품 중개업",
"단위": "백만원",
"유가": ""
},
"텔레픽스|2026-04-30": {
"매출액": "4,896",
"순이익": "-16,214",
"자기자본": "9,146",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"네오사피엔스|2026-04-22": {
"매출액": "10,649",
"순이익": "-6,994",
"자기자본": "-39,962",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"엠에스바이오|2026-04-16": {
"매출액": "23,787",
"순이익": "7,288",
"자기자본": "1,942",
"업종": "의료용 기기 제조업",
"단위": "백만원",
"유가": ""
},
"글로벌테크놀로지|2026-04-13": {
"매출액": "29,689",
"순이익": "-25,889",
"자기자본": "6,402",
"업종": "반도체 제조업",
"단위": "백만원",
"유가": ""
},
"엠비디|2026-04-10": {
"매출액": "1,524",
"순이익": "-2,125",
"자기자본": "2,753",
"업종": "물질 검사, 측정 및 분석기구 제조업",
"단위": "백만원",
"유가": ""
},
"옵토닉스|2026-04-08": {
"매출액": "25,368",
"순이익": "1,901",
"자기자본": "730",
"업종": "광학렌즈 및 광학요소 제조업",
"단위": "백만원",
"유가": ""
},
"크리에이츠|2026-04-07": {
"매출액": "76,395",
"순이익": "23,749",
"자기자본": "2,335",
"업종": "그외 기타 제품 제조업",
"단위": "백만원",
"유가": ""
},
"인텔리빅스|2026-03-24": {
"매출액": "46,644",
"순이익": "5,357",
"자기자본": "1,048",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"피지티|2026-02-27": {
"매출액": "40,141",
"순이익": "-69,722",
"자기자본": "6,029",
"업종": "기타 화학제품 제조업",
"단위": "백만원",
"유가": ""
},
"덕산넵코어스|2025-11-11": {
"매출액": "48,504",
"순이익": "3,668",
"자기자본": "8,448",
"업종": "항공기,우주선 및 부품 제조업",
"단위": "백만원",
"유가": ""
},
"디티에스|2025-09-18": {
"매출액": "142,718",
"순이익": "18,765",
"자기자본": "63,153",
"업종": "특수 목적용 기계 제조업",
"단위": "백만원",
"유가": ""
},
"씨엠디엘|2025-09-11": {
"매출액": "39,991",
"순이익": "3,541",
"자기자본": "503",
"업종": "기타 기초 유기 화학물질 제조업",
"단위": "백만원",
"유가": ""
},
"기도산업|2026-04-21": {
"매출액": "346,551",
"순이익": "35,334",
"자기자본": "145,991",
"업종": "봉제의복 제조업",
"단위": "백만원",
"유가": ""
},
"와이즈플래닛컴퍼니|2026-04-15": {
"매출액": "44,578",
"순이익": "7,748",
"자기자본": "959",
"업종": "광고물 문안, 도안, 설계 등 작성업",
"단위": "백만원",
"유가": ""
},
"브릴스|2026-04-16": {
"매출액": "23,759",
"순이익": "1,744",
"자기자본": "4,785",
"업종": "특수 목적용 기계 제조업",
"단위": "백만원",
"유가": ""
},
"니어스랩|2026-03-23": {
"매출액": "6,361",
"순이익": "-7,287",
"자기자본": "127",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"스카이랩스|2026-01-30": {
"매출액": "7,936",
"순이익": "-62,995",
"자기자본": "8,341",
"업종": "의료용 기기 제조업",
"단위": "백만원",
"유가": ""
},
"해치텍|2026-03-23": {
"매출액": "14,079",
"순이익": "-8,009",
"자기자본": "2,229",
"업종": "반도체 제조업",
"단위": "백만원",
"유가": ""
},
"에이치엘지노믹스|2026-04-03": {
"매출액": "28,877",
"순이익": "8,452",
"자기자본": "83,552",
"업종": "기초 의약물질 제조업",
"단위": "백만원",
"유가": ""
},
"딜리셔스|2026-02-25": {
"매출액": "25,149",
"순이익": "-20,419",
"자기자본": "-114,384",
"업종": "무점포 소매업",
"단위": "백만원",
"유가": ""
},
"인제니아테라퓨틱스|2026-01-30": {
"매출액": "2,588,400",
"순이익": "15,755,864",
"자기자본": "30,841,690",
"업종": "자연과학 및 공학 연구개발업",
"단위": "USD",
"유가": ""
},
"레메디|2026-01-30": {
"매출액": "13,441",
"순이익": "741",
"자기자본": "5,870",
"업종": "의료용 기기 제조업",
"단위": "백만원",
"유가": ""
},
"케이앤에스아이앤씨|2026-01-16": {
"매출액": "13,482",
"순이익": "-2,213",
"자기자본": "4,273",
"업종": "통신 및 방송 장비 제조업",
"단위": "백만원",
"유가": ""
},
"한화|2026-01-14": {
"매출액": "5,882,542",
"순이익": "197,354",
"자기자본": "3,412,472",
"업종": "기타 화학제품 제조업",
"단위": "백만원",
"유가": "Y"
},
"넥스트젠바이오|2025-12-23": {
"매출액": "100",
"순이익": "69",
"자기자본": "4,792",
"업종": "자연과학 및 공학 연구개발업",
"단위": "백만원",
"유가": ""
},
"파워큐브세미|2026-01-16": {
"매출액": "10,341",
"순이익": "-10,837",
"자기자본": "841",
"업종": "반도체 제조업",
"단위": "백만원",
"유가": ""
},
"제이피이노베이션|2026-03-25": {
"매출액": "56,324",
"순이익": "5,588",
"자기자본": "3,684",
"업종": "특수 목적용 기계 제조업",
"단위": "백만원",
"유가": ""
},
"케이솔루션|2026-02-12": {
"매출액": "34,565",
"순이익": "1,158",
"자기자본": "653",
"업종": "차체 및 특장차 제조업",
"단위": "백만원",
"유가": ""
},
"디토닉|2025-11-13": {
"매출액": "31,293",
"순이익": "-1,633",
"자기자본": "-21,926",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"에스케이팩|2025-11-28": {
"매출액": "27,310",
"순이익": "2,257",
"자기자본": "3,207",
"업종": "용기 세척, 포장 및 충전기 제조업",
"단위": "백만원",
"유가": ""
},
"메타넷엑스|2025-12-09": {
"매출액": "244,130",
"순이익": "13,455",
"자기자본": "9,995",
"업종": "컴퓨터 프로그래밍, 시스템 통합 및 관리업",
"단위": "백만원",
"유가": ""
},
"무아스|2025-11-26": {
"매출액": "41,813",
"순이익": "3,903",
"자기자본": "532",
"업종": "가정용 전기기기 제조업",
"단위": "백만원",
"유가": ""
},
"유빅스테라퓨틱스|2025-11-04": {
"매출액": "1,071",
"순이익": "-15,145",
"자기자본": "5,489",
"업종": "자연과학 및 공학 연구개발업",
"단위": "백만원",
"유가": ""
},
"코드잇|2025-11-06": {
"매출액": "30,747",
"순이익": "6,652",
"자기자본": "2,403",
"업종": "교육지원 서비스업",
"단위": "백만원",
"유가": ""
},
"한컴인스페이스|2025-08-13": {
"매출액": "23,492",
"순이익": "-3,104",
"자기자본": "5,815",
"업종": "소프트웨어 개발 및 공급업",
"단위": "백만원",
"유가": ""
},
"크몽|2025-08-29": {
"매출액": "48,572",
"순이익": "3,988",
"자기자본": "4,930",
"업종": "기타 정보 서비스업",
"단위": "백만원",
"유가": ""
},
"한화플러스제6호스팩|2025-11-24": {
"매출액": "-",
"순이익": "-",
"자기자본": "41",
"업종": "기타 금융업",
"단위": "백만원",
"유가": ""
},
"에식스솔루션즈|2025-11-07": {
"매출액": "2,461",
"순이익": "46",
"자기자본": "200",
"업종": "절연선 및 케이블 제조업",
"단위": "USD mn, FY24",
"유가": "Y"
},
"에코크레이션|2025-07-04": {
"매출액": "18,544",
"순이익": "-15,634",
"자기자본": "4,550",
"업종": "일반 목적용 기계 제조업",
"단위": "백만원",
"유가": ""
}
}

# 결과확정일이 KIND에 비어 있는 건의 보정값 (원문 공시 기준)
DATE_OVERRIDE = {"한화|2026-01-14": "2026-04-23", "에코크레이션|2025-07-04": "2026-01-23"}

ABBR = {
 "미래에셋증권":"미래","엔에이치투자증권":"NH","한국투자증권":"한국","대신증권":"대신",
 "삼성증권":"삼성","KB증권":"KB","IBK투자증권":"IBK","유진투자증권":"유진",
 "DB증권":"DB","신한투자증권":"신한","SK증권":"SK","한화투자증권":"한화",
 "하나증권":"하나","비엔케이투자증권":"BNK","교보증권":"교보","키움증권":"키움",
 "메리츠증권":"메리츠","신영증권":"신영","유안타증권":"유안타","현대차증권":"현대차",
}

def nz(s): return (s or "").replace(" ", "").strip()
def base(n): return (n or "").strip().rstrip("*")
def norm(n):
    n = base(n).replace(" ", "").replace("기업인수목적", "스팩")
    return re.sub(r"주식회사|\(주\)", "", n)
def fkey(name, appdate): return f"{norm(name)}|{appdate.strip()}"

def abbr(s):
    out = []
    for p in re.split(r"[,，]\s*", s or ""):
        p2 = re.sub(r"주식회사|\(주\)|\s", "", p)
        hit = next((sh for full, sh in ABBR.items() if full.replace(" ", "") in p2), None)
        out.append(hit or p.strip())
    return ", ".join(x for x in out if x)

def classify(sim):
    s = nz(sim)
    if s == "청구서접수": return "신청"
    if s == "심사승인":   return "승인"
    if s in ("심사철회", "심사미승인"): return "철회미승인"
    if s == "상장승인":   return "신규상장"
    if s in ("상장철회", "공모철회"): return "별도"
    return "기타"

# ══════════════ 1) 목록 수집 ══════════════
def fetch_list(sess):
    payload = {
        "method": "searchListInvstgCorpSub", "forward": "listinvstgcom_sub",
        "currentPageSize": "1000", "pageIndex": "1", "orderMode": "2", "orderStat": "D",
        "listTypeArrStr": "01|02|03|04|05|06|07",
        "invstgRsltArrStr": "01|02|03|04|05|08|07|06",
        "marketType": "", "searchCorpName": "",
        "fromDate": (dt.date.today() - dt.timedelta(days=365*3)).isoformat(),
        "toDate": dt.date.today().isoformat(),
    }
    r = sess.post(URL, data=payload, headers=HEADERS, timeout=25)
    r.encoding = "utf-8"
    if r.status_code != 200 or len(r.text) < 100:
        raise RuntimeError(f"목록 응답 이상 status={r.status_code}")
    soup = BeautifulSoup(r.text, "lxml")
    rows = []
    for tr in soup.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 6:
            continue
        name = tds[0].get("title") or tds[0].get_text(strip=True)
        if not name or name == "회사명":
            continue
        img = tds[0].find("img", alt=True)
        market = ""
        if img:
            alt = img.get("alt", "")
            market = "유가" if "유가" in alt else ("코스닥" if "코스닥" in alt else "")
        onclick = (tr.get("onclick") or "")
        if not onclick:
            el = tr.find(attrs={"onclick": re.compile(r"fnDetailView")})
            onclick = el.get("onclick", "") if el else ""
        m = re.search(r"fnDetailView\('(\d{12,16})'\)", onclick)
        rows.append({
            "회사명": base(name), "시장": market,
            "상장유형": tds[1].get_text(strip=True),
            "청구일": tds[2].get_text(strip=True),
            "결과확정일": tds[3].get_text(strip=True),
            "심사결과": tds[4].get_text(strip=True),
            "상장주선인": tds[5].get_text(strip=True),
            "bizProcNo": m.group(1) if m else "",
        })
    return rows

# ══════════════ 2) 상세 파서 v2 (라벨 정확매칭 · USD 판별) ══════════════
def fetch_detail(sess, biz):
    r = sess.get(URL, params={"method": "searchListInvstgCorpDetail", "bizProcNo": biz},
                 headers=HEADERS, timeout=20)
    r.encoding = "utf-8"
    soup = BeautifulSoup(r.text, "lxml")
    out = {"매출액": "", "순이익": "", "자기자본": "", "업종": "", "국적": "", "단위": "백만원"}
    for th in soup.find_all("th"):
        label = nz(th.get_text())
        td = th.find_next_sibling("td")
        if td is None:
            continue
        raw = td.get_text(" ", strip=True)
        if label.startswith("매출액"):
            key = "매출액"
        elif label == "순이익":
            key = "순이익"
        elif label == "자기자본":
            key = "자기자본"
        elif label == "업종":
            if not out["업종"]: out["업종"] = raw
            continue
        elif label == "국적":
            out["국적"] = raw
            continue
        else:
            continue
        m = re.search(r"(-?[\d,]+)", raw)
        if m and not out[key]:
            out[key] = m.group(1)
            if "USD" in raw.upper():
                out["단위"] = "USD"
    return out

# ══════════════ 3) 저장소 ══════════════
def load_json(path, default):
    if not os.path.exists(path): return default
    with open(path, encoding="utf-8") as f: return json.load(f)

def save_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)

def log(lines):
    if not lines: return
    stamp = dt.datetime.now().isoformat(timespec="seconds")
    with open(LOG, "a", encoding="utf-8") as f:
        for ln in lines: f.write(f"{stamp}\t{ln}\n")

# ══════════════ 4) 메인 ══════════════
def main():
    print("=" * 62)
    print(f" KIND IPO 주간 통합 수집  (당해연도 {YEAR}, 기준일 {TODAY})")
    print("=" * 62)
    sess = requests.Session()
    try: sess.get(REFERER, headers=HEADERS, timeout=15)
    except Exception: pass

    # ── 목록 ──
    try:
        fresh = fetch_list(sess)
    except Exception as e:
        print("\n[실패] 목록 수집: " + str(e))
        input("\nEnter 키로 종료..."); return
    print(f"[1/5] 목록 수집: {len(fresh)}건")

    # ── master 증분 ──
    master = load_json(MASTER, {"records": {}})
    store = master["records"]
    now = dt.datetime.now().isoformat(timespec="seconds")
    added, changed = [], []
    for rec in fresh:
        k = f"{rec['회사명']}||{rec['청구일']}"
        cur = "심사중" if classify(rec["심사결과"]) == "신청" else "결과확정"
        if k not in store:
            store[k] = {**rec, "상태": cur, "최초수집": now, "최근확인": now,
                        "상태변경이력": [{"상태": cur, "시각": now}]}
            added.append(f"신규\t{rec['청구일']}\t{rec['회사명']}\t{rec['심사결과']}")
        else:
            it = store[k]; it["최근확인"] = now
            for fld in ("시장", "bizProcNo"):
                if rec.get(fld) and not it.get(fld): it[fld] = rec[fld]
            if it.get("상태") != cur or nz(it.get("심사결과","")) != nz(rec["심사결과"]):
                it["상태변경이력"] = it.get("상태변경이력", []) + [
                    {"상태": cur, "시각": now, "심사결과": rec["심사결과"]}]
                it["상태"], it["결과확정일"], it["심사결과"] = cur, rec["결과확정일"], rec["심사결과"]
                changed.append(f"상태변경\t{rec['청구일']}\t{rec['회사명']}\t-> {rec['심사결과']}")
    save_json(MASTER, master)
    print(f"[2/5] 정본 갱신: 신규 {len(added)} / 상태변경 {len(changed)} (누적 {len(store)})")

    # ── 재무 저장소 (시드 병합) ──
    fin = load_json(FINDATA, {})
    seeded = 0
    for k, v in SEED_FIN.items():
        if k not in fin: fin[k] = {**v, "출처": "시드(검증완료)"}; seeded += 1
    if seeded: print(f"      시드 재무 반영: {seeded}건")

    # ── 표 대상 선별 ──
    def result_date(rec):
        d = (rec.get("결과확정일") or "").strip()
        return d or DATE_OVERRIDE.get(fkey(rec["회사명"], rec["청구일"]), "")

    t_apply, t_appr, t_drop, need_detail = [], [], [], []
    for rec in fresh:
        c = classify(rec["심사결과"])
        if rec["상장유형"].replace(" ", "") == "재상장" and c in ("승인", "철회미승인"):
            continue  # 주5) 재상장 제외
        if c == "신청":
            t_apply.append(rec)
        elif c == "승인" and result_date(rec).startswith(YEAR):
            t_appr.append(rec)
        elif c == "철회미승인" and result_date(rec).startswith(YEAR):
            t_drop.append(rec)
        else:
            continue
        if fkey(rec["회사명"], rec["청구일"]) not in fin and rec.get("bizProcNo"):
            need_detail.append(rec)

    # ── 신규만 상세 수집 ──
    print(f"[3/5] 상세 수집 대상(재무 미보유 신규): {len(need_detail)}건")
    for rec in need_detail:
        try:
            d = fetch_detail(sess, rec["bizProcNo"])
            yuga = "Y" if rec.get("시장") == "유가" else ""
            fin[fkey(rec["회사명"], rec["청구일"])] = {
                "매출액": d["매출액"], "순이익": d["순이익"], "자기자본": d["자기자본"],
                "업종": d["업종"], "단위": d["단위"], "유가": yuga,
                "출처": f"KIND상세({TODAY})"}
            print(f"      + {rec['청구일']} {rec['회사명']:<16} "
                  f"매출 {d['매출액'] or '-':>10} ({d['단위']})")
            log([f"상세수집\t{rec['청구일']}\t{rec['회사명']}\t{d['매출액']}|{d['순이익']}|{d['자기자본']}|{d['단위']}"])
        except Exception as e:
            print(f"      ! 실패 {rec['회사명']}: {e}")
            log([f"상세실패\t{rec['청구일']}\t{rec['회사명']}\t{e}"])
    save_json(FINDATA, fin)

    # ── 표 조립 ──
    def build(rows, datefn, extra_col=None):
        out = []
        for rec in rows:
            f = fin.get(fkey(rec["회사명"], rec["청구일"]), {})
            unit = f.get("단위", "백만원")
            cy = rec["청구일"][:4]
            if "FY24" in unit:
                base_year = "2024"
            elif cy.isdigit():
                base_year = str(int(cy) - 1)
            else:
                base_year = ""
            item = {"일자": datefn(rec), "회사명": rec["회사명"],
                    "유가": f.get("유가") or ("Y" if rec.get("시장") == "유가" else ""),
                    "상장유형": rec["상장유형"], "심사결과": rec["심사결과"],
                    "기준연도": base_year,
                    "매출액": f.get("매출액", ""), "순이익": f.get("순이익", ""),
                    "자기자본": f.get("자기자본", ""), "업종": f.get("업종", ""),
                    "단위": unit,
                    "대표주관사": abbr(rec["상장주선인"])}
            out.append(item)
        out.sort(key=lambda r: r["일자"], reverse=True)
        return out

    T1 = build(t_apply, lambda r: r["청구일"])
    T2 = build(t_appr,  result_date)
    T3 = build(t_drop,  result_date)
    print(f"[4/5] 표 구성: 신청 {len(T1)} / 승인 {len(T2)} / 철회·미승인 {len(T3)}")

    DATA = {"asof": TODAY, "year": YEAR,
            "fin_basis": "청구일 직전 사업연도 · 별도/개별 재무제표 · 단위 백만원(별도 표기 시 USD)",
            "tables": {"신청": T1, "승인": T2, "철회미승인": T3},
            "counts": {"신청": len(T1), "승인": len(T2), "철회미승인": len(T3)}}

    html = TEMPLATE.replace("__DATA__", json.dumps(DATA, ensure_ascii=False))
    with open(SITE, "w", encoding="utf-8") as f: f.write(html)
    print(f"[5/5] index.html 재생성 완료")

    log(added + changed)
    print("\n── 요약 " + "─" * 40)
    print(f"  신규 등록 {len(added)} / 상태변경 {len(changed)} / 상세수집 {len(need_detail)}")
    print(f"  표: 신청 {len(T1)} · 승인 {len(T2)} · 철회미승인 {len(T3)}")
    miss = [r["회사명"] for t in (T1, T2, T3) for r in t if not r["매출액"] and r["회사명"] != "한화플러스제6호스팩" and "스팩" not in r["회사명"]]
    if miss:
        print(f"  ※ 재무 미확보(확인 필요): {miss}")
    print("\n[완료] index.html 을 열어 확인하거나 GitHub에 업로드하세요.")
    input("\nEnter 키로 종료...")


# ══════════════ HTML 템플릿 ══════════════
TEMPLATE = r'''<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IPO 상장예비심사 현황</title>
<link href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css" rel="stylesheet">
<style>
:root{--bg:#F4F6F8;--card:#fff;--ink:#14213A;--muted:#63718A;--faint:#9AA6B8;
 --line:#E4E8EE;--line2:#EEF1F5;--accent:#2350B4;--accent-soft:#EAF0FB;--neg:#C23B34;
 --k1:#2350B4;--k2:#1E7F4F;--k3:#9A4A44;
 --font:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);
 font-feature-settings:"tnum" 1;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1240px;margin:0 auto;padding:0 20px}
header.top{position:sticky;top:0;z-index:20;background:rgba(244,246,248,.88);
 backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.head-in{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:15px 20px}
.brand{margin-right:auto}
.ey{font-size:11px;font-weight:700;letter-spacing:.15em;color:var(--accent)}
.brand h1{margin:2px 0 0;font-size:20px;font-weight:800;letter-spacing:-.01em}
.asof{font-size:12.5px;color:var(--muted)}
.search{position:relative}
.search input{width:230px;max-width:60vw;padding:9px 12px 9px 34px;border:1px solid var(--line);
 border-radius:10px;font:inherit;font-size:13.5px;outline:none;background:#fff}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--faint)}
.chips{display:flex;gap:10px;flex-wrap:wrap;padding:18px 0 4px}
.chip{flex:1 1 170px;text-decoration:none;color:inherit;background:#fff;border:1px solid var(--line);
 border-radius:12px;padding:13px 15px;position:relative;overflow:hidden;transition:transform .15s,box-shadow .15s}
.chip:hover{transform:translateY(-2px);box-shadow:0 8px 22px -14px rgba(20,33,58,.4)}
.chip::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--kc)}
.chip .cl{font-size:12.5px;color:var(--muted);font-weight:600}
.chip .cn{font-size:27px;font-weight:800;margin-top:3px}
.chip .cs{font-size:11.5px;color:var(--faint);font-weight:600}
main{padding:8px 0 40px}
.stage{background:#fff;border:1px solid var(--line);border-radius:14px;margin-top:20px;overflow:hidden;scroll-margin-top:80px}
.st-head{display:flex;gap:13px;padding:17px 20px 13px;border-bottom:1px solid var(--line2)}
.st-no{font-size:12px;font-weight:800;color:#fff;background:var(--kc);min-width:30px;height:30px;
 border-radius:8px;display:grid;place-items:center;margin-top:2px}
.st-title{font-size:17px;font-weight:800;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.st-count{font-size:12px;font-weight:700;color:var(--kc);border:1px solid currentColor;border-radius:20px;padding:1px 9px}
.st-desc{font-size:13px;color:var(--muted);margin-top:3px}
.tbl-scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
thead th{background:#F8FAFC;color:var(--muted);font-weight:700;font-size:11.5px;text-align:left;
 padding:9px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
tbody td{padding:9px 14px;border-bottom:1px solid var(--line2);white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#FAFBFD}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.neg{color:var(--neg)}
td.dash{color:var(--faint);text-align:right}
td.fy{font-variant-numeric:tabular-nums;font-weight:700;color:var(--muted);font-size:12px}
td.fy.fyold{color:#B8791A}
td.fy.fyold::after{content:" ⚠";font-size:10px}

td.nm{font-weight:700}
.badge{display:inline-block;font-size:10px;font-weight:800;color:#fff;background:#B8791A;
 border-radius:4px;padding:1px 5px;margin-left:6px;vertical-align:1px}
.badge.usd{background:#6D4AA6}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;
 background:var(--accent-soft);color:var(--accent)}
.tag.spac{background:#F0EAF7;color:#6D4AA6}
.tag.drop{background:#F6EAE9;color:#9A4A44}
.no-hit{padding:22px;text-align:center;color:var(--faint);font-size:13px;display:none}
footer{margin-top:30px;padding:22px 0 60px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
footer .src{font-weight:600;color:var(--ink)}
footer ul{margin:10px 0 0;padding-left:18px}
footer li{margin:4px 0}
footer .disc{margin-top:14px;padding:12px 14px;background:#fff;border:1px solid var(--line);border-radius:10px;line-height:1.6}
@media(max-width:640px){.brand h1{font-size:17px}.chip .cn{font-size:22px}
 .search{flex:1 1 100%;order:3}.search input{width:100%;max-width:none}}
</style>
</head>
<body>
<header class="top"><div class="head-in">
 <div class="brand"><span class="ey">KIND 공시 기반 · 매주 갱신</span><h1>IPO 상장예비심사 현황</h1></div>
 <span class="asof" id="asof"></span>
 <div class="search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
 <input id="q" type="search" placeholder="회사·업종·주관사 검색" aria-label="검색"></div>
</div></header>

<div class="wrap">
 <nav class="chips" id="chips"></nav>
 <main id="main"></main>
 <div class="no-hit" id="nohit">검색어에 해당하는 기업이 없습니다.</div>
 <footer>
  <div class="src">출처 · 한국거래소 KIND 상장예비심사 공시</div>
  <ul>
   <li><b>유가</b> 배지는 유가증권시장 대상 기업, 그 외는 코스닥입니다.</li>
   <li><b>기준연도(FY)</b>는 재무 수치의 사업연도로, 청구일의 직전 사업연도입니다. 당해 연도보다 이른 연도(예: FY24)는 <b style="color:#B8791A">⚠</b>로 표시되며, 실적이 다소 이전 시점임을 뜻합니다.</li>
   <li>매출액·순이익·자기자본은 <b>해당 기준연도 · 별도/개별 재무제표</b> 기준, 단위 <b>백만원</b>입니다. <span class="badge usd">USD</span> 배지는 미달러 단위(외국기업 등)입니다.</li>
   <li>신청법인의 일자는 <b>심사청구일</b>, 승인·철회·미승인의 일자는 <b>결과 확정일</b>입니다.</li>
   <li>승인·철회·미승인은 <b>당해 연도 누적</b>입니다. 신규상장·이전상장(코넥스→코스닥)·SPAC 합병 포함, 재상장 제외.</li>
  </ul>
  <div class="disc">본 페이지는 공개 공시정보를 취합한 <b>투자 참고용</b> 자료로, 정확성·완전성을 보장하지 않으며 지연·오류가 있을 수 있습니다. 투자 판단 전 KIND 원문 공시를 확인하시기 바랍니다.</div>
 </footer>
</div>

<script>
const DATA=__DATA__;
document.getElementById('asof').textContent='기준일 '+DATA.asof;
const META={
 '신청':{no:'01',kc:'var(--k1)',title:'심사 신청 (심사 진행 중)',desc:'상장예비심사를 청구하고 결과가 나오지 않은 기업 · 일자=청구일',cols:['일자','회사명','상장유형','기준연도','매출액','순이익','자기자본','업종','대표주관사']},
 '승인':{no:'02',kc:'var(--k2)',title:'심사 승인',desc:DATA.year+'년 승인 누적 · 일자=승인일',cols:['일자','회사명','상장유형','기준연도','매출액','순이익','자기자본','업종','대표주관사']},
 '철회미승인':{no:'03',kc:'var(--k3)',title:'철회 · 미승인',desc:DATA.year+'년 누적 · 일자=결과 확정일',cols:['일자','회사명','심사결과','기준연도','매출액','순이익','자기자본','업종','대표주관사']},
};
const NUM=['매출액','순이익','자기자본'];
const chips=document.getElementById('chips');
for(const key of ['신청','승인','철회미승인']){
 const a=document.createElement('a');a.className='chip';a.href='#s-'+key;
 a.style.setProperty('--kc',META[key].kc);
 a.innerHTML=`<div class="cl">${META[key].title}</div><div class="cn">${DATA.tables[key].length}</div><div class="cs">${key==='신청'?'현재 진행 중':DATA.year+'년 누적'}</div>`;
 chips.appendChild(a);
}
const main=document.getElementById('main');
for(const key of ['신청','승인','철회미승인']){
 const mt=META[key],rows=DATA.tables[key];
 const sec=document.createElement('section');sec.className='stage';sec.id='s-'+key;
 sec.style.setProperty('--kc',mt.kc);
 const thead='<tr>'+mt.cols.map(c=>`<th class="${NUM.includes(c)?'num':''}">${c}</th>`).join('')+'</tr>';
 const body=rows.map(r=>{
  const cells=mt.cols.map(c=>{
   let v=r[c]??'';
   if(c==='회사명'){
    let b='';
    if(r['유가']==='Y')b+='<span class="badge">유가</span>';
    if((r['단위']||'').includes('USD'))b+='<span class="badge usd">'+(r['단위']==='USD'?'USD':r['단위'])+'</span>';
    return `<td class="nm">${v}${b}</td>`;
   }
   if(c==='기준연도'){
    if(!v) return '<td class="dash">–</td>';
    const fy=parseInt(v,10), cur=parseInt(DATA.year,10);
    const stale=(cur-fy)>=2;   // 직전연도(cur-1)까지는 정상, 2년 이상 이전만 경고
    return `<td class="fy${stale?' fyold':''}">FY${String(v).slice(2)}</td>`;
   }
   if(c==='상장유형'||c==='심사결과'){
    let cls='tag';if(String(v).includes('스팩'))cls+=' spac';
    if(String(v).includes('철회')||String(v).includes('미승인'))cls+=' drop';
    return `<td><span class="${cls}">${v||'-'}</span></td>`;
   }
   if(v==='-'||v===''){return '<td class="dash">–</td>';}
   if(NUM.includes(c)){
    const neg=String(v).trim().startsWith('-');
    return `<td class="num${neg?' neg':''}">${v}</td>`;
   }
   return `<td>${v}</td>`;
  }).join('');
  const hay=[r['회사명'],r['업종'],r['대표주관사'],r['상장유형'],r['심사결과']].join(' ');
  return `<tr data-hay="${hay.replace(/"/g,'')}">${cells}</tr>`;
 }).join('');
 sec.innerHTML=`<div class="st-head"><div class="st-no">${mt.no}</div><div>
  <div class="st-title">${mt.title}<span class="st-count">${rows.length}개사</span></div>
  <div class="st-desc">${mt.desc}</div></div></div>
  <div class="tbl-scroll"><table><thead>${thead}</thead><tbody>${body}</tbody></table></div>`;
 main.appendChild(sec);
}
const q=document.getElementById('q'),nohit=document.getElementById('nohit');
q.addEventListener('input',()=>{
 const t=q.value.trim().toLowerCase();let any=false;
 document.querySelectorAll('.stage').forEach(sec=>{
  let n=0;
  sec.querySelectorAll('tbody tr').forEach(tr=>{
   const hit=!t||(tr.dataset.hay||'').toLowerCase().includes(t);
   tr.style.display=hit?'':'none';if(hit)n++;
  });
  sec.style.display=n?'':'none';if(n)any=true;
 });
 nohit.style.display=any?'none':'block';
});
</script>
</body>
</html>'''

if __name__ == "__main__":
    main()
