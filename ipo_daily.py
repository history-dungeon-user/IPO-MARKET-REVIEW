# -*- coding: utf-8 -*-
"""
ipo_daily.py — IPO 통합 일일 자동화 (예심 + 공모~상장 + 3탭 엑셀 + 웹페이지)
================================================================================
실행: python ipo_daily.py          (kind_weekly.py 와 같은 폴더에 두고 실행)
필요: pip install requests beautifulsoup4 openpyxl

구성
  [1] KIND 예심 수집·3표          → kind_weekly.py 로직 재사용 (import)
  [2] KIND 신규상장 페이지 수집    → 상장일 확정 소스 (listingcompany.do)
  [3] DART 신고서 추적·발췌        → 승인법인 공모 데이터 (OpenDART API)
  [4] 3탭 엑셀 생성                → IPO_analysis.xlsx
  [5] index.html 재생성            → kind_weekly.py 가 담당

검증된 발췌 규칙 (2026-07-07 확정)
  - 최신 정정본 우선: 접수일 최신 rcept_no 1건만 사용
  - 기재정정/발행조건확정 문서 내 정정 전·후 병존 → "정정 후" 값만 취함
  - 공모개요표: 증권수량/모집(매출)가액(=밴드하단)/모집(매출)총액
  - 인수대가 + 주석 수수료율(%) / 성과수수료 별도
  - 밸류에이션: 평가모형(PER/PSR/EV/EBITDA) + 비교회사 배수 (표기 변형 허용)
  - 수요예측 참여내역표: 건수·경쟁률 행의 '합계' 열
  - 실적보고서: (일반)청약경쟁률 = 일반투자자 청약수량 ÷ 최종배정수량
  - 상장일: KIND 신규상장 페이지 등재 시 확정 (그 전엔 상장예정일)
"""
import os, re, sys, json, zipfile, io, datetime
import requests

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

# ── 설정 ─────────────────────────────────────────────────────────────
DART_API_KEY = os.environ.get("DART_API_KEY", "")   # 환경변수 또는 아래에 직접 입력
if not DART_API_KEY:
    # D:\dart-mcp\dart_mcp.py 에서 키 자동 탐색 시도
    try:
        sys.path.insert(0, r"D:\dart-mcp")
        import dart_mcp as _dm
        for attr in ("DART_API_KEY", "API_KEY", "DART_KEY"):
            if hasattr(_dm, attr):
                DART_API_KEY = getattr(_dm, attr); break
    except Exception:
        pass

OFFERING_JSON = os.path.join(BASE, "offering_master.json")   # 공모 추적 정본
LISTING_JSON  = os.path.join(BASE, "listing_master.json")    # 신규상장 정본
XLSX_OUT      = os.path.join(BASE, "IPO_analysis.xlsx")

DART = "https://opendart.fss.or.kr/api"
KIND = "https://kind.krx.co.kr"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": KIND + "/listinvstg/listingcompany.do",
}

# 승인법인 corp_code 시드 (검증 완료 · 신규 승인법인은 자동 매칭 후 추가)
CORP_SEED = {
 "기도산업":"00229085","브릴스":"01801026","니어스랩":"01588897","스카이랩스":"01586923",
 "해치텍":"01947443","와이즈플래닛컴퍼니":"01867688","케이앤에스아이앤씨":"00920731",
 "빅웨이브로보틱스":"01722066","인제니아테라퓨틱스":"02031369","에이치엘지노믹스":"00624244",
 "레메디":"01501764","딜리셔스":"01461730",
}

TODAY = datetime.date.today().strftime("%Y%m%d")


# ════════════════════════════════════════════════════════════════════
# [2] KIND 신규상장 페이지 (상장일 확정 소스)
# ════════════════════════════════════════════════════════════════════
def fetch_new_listings(sess, year=None):
    """listingcompany.do 신규상장 목록 → [{회사명, 상장일, 상장유형, 시장}]
    ※ F12 실측(2026-07-08) 확정 파라미터:
       method=searchListingTypeSub, forward=listingtype_sub,
       listTypeArrStr=01|02|03|04|05|  (신규·이전·재상장·폐지·합병)
       secuGrpArrStr=0|ST|FS|MF|SC|RT|IF|DR|  (전체 증권구분)
    ※ Main(폼)이 아니라 Sub(데이터)를 호출해야 목록이 반환됨."""
    year = year or datetime.date.today().year
    url = KIND + "/listinvstg/listingcompany.do"
    # 폼 세션 확보 (Referer/쿠키)
    try:
        sess.get(url + "?method=searchListingTypeMain", headers=HEADERS, timeout=20)
    except Exception:
        pass
    data = {
        "method": "searchListingTypeSub",
        "forward": "listingtype_sub",
        "currentPageSize": "500", "pageIndex": "1",
        "orderMode": "1", "orderStat": "D",
        "listTypeArrStr": "01|02|03|04|05|",
        "secuGrpArrStr": "0|ST|FS|MF|SC|RT|IF|DR|",
        "fromDate": f"{year}-01-01",
        "toDate": datetime.date.today().strftime("%Y-%m-%d"),
    }
    hdr = dict(HEADERS)
    hdr["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
    hdr["Origin"] = KIND
    hdr["Referer"] = url + "?method=searchListingTypeMain"
    try:
        r = sess.post(url, data=data, headers=hdr, timeout=30)
        r.raise_for_status()
    except Exception as e:
        print(f"  [경고] 신규상장 페이지 접속 실패: {e}")
        return None
    if "잠시 후" in r.text or len(r.text) < 500:
        print("  [경고] 신규상장 응답이 비정상(차단 또는 빈 응답)")
        return None
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(r.text, "html.parser")
    rows = []
    for tr in soup.select("table tbody tr, table tr"):
        tds = tr.find_all("td")
        if len(tds) < 4:
            continue
        name = tds[0].get_text(strip=True)
        date = tds[1].get_text(strip=True).replace(".", "-")
        ltype = tds[2].get_text(strip=True) if len(tds) > 2 else ""
        # 시장 판별: 회사명 셀의 아이콘(alt/src/class) 전체를 훑음
        market = ""
        img = tds[0].find("img")
        blob = ""
        if img:
            blob = " ".join([img.get("alt", ""), img.get("src", ""),
                             " ".join(img.get("class", []))]).lower()
        # 행 전체 텍스트/클래스도 보조 신호로 활용
        row_txt = tr.get_text(" ", strip=True)
        if "유가" in blob or "market_yu" in blob or "icn_t_yu" in blob or "유가" in row_txt[:0]:
            market = "유가"
        elif "코넥스" in blob or "knx" in blob or "icn_t_kn" in blob or "kn.gif" in blob:
            market = "코넥스"
        elif "코스닥" in blob or "market_ko" in blob or "icn_t_ko" in blob or "ko.gif" in blob:
            market = "코스닥"
        # 코넥스는 IPO(코스닥·유가) 대상이 아니므로 제외
        if market == "코넥스":
            continue
        if re.match(r"\d{4}-\d{2}-\d{2}", date) and name:
            rows.append({"회사명": name, "상장일": date,
                         "상장유형": ltype, "시장": market})
    return rows


# ════════════════════════════════════════════════════════════════════
# [3] DART 신고서 추적·발췌
# ════════════════════════════════════════════════════════════════════
def dart_list(corp_code, bgn="20260101"):
    """공시목록 (발행공시 C)"""
    r = requests.get(f"{DART}/list.json", params={
        "crtfc_key": DART_API_KEY, "corp_code": corp_code,
        "bgn_de": bgn, "end_de": TODAY, "pblntf_ty": "C",
        "page_count": 100}, timeout=30)
    j = r.json()
    return j.get("list", []) if j.get("status") == "000" else []

def dart_document_text(rcept_no):
    """원문 ZIP → 전체 텍스트 (표는 '|' 구분으로 평탄화)"""
    r = requests.get(f"{DART}/document.xml", params={
        "crtfc_key": DART_API_KEY, "rcept_no": rcept_no}, timeout=60)
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    texts = []
    for name in zf.namelist():
        raw = zf.read(name)
        for enc in ("utf-8", "euc-kr", "cp949"):
            try:
                s = raw.decode(enc); break
            except Exception:
                s = raw.decode("utf-8", "ignore")
        # 표 셀 경계 유지하며 태그 제거
        s = re.sub(r"</T[DHU][^>]*>", " | ", s, flags=re.I)
        s = re.sub(r"</TR[^>]*>", "\n", s, flags=re.I)
        s = re.sub(r"<[^>]+>", " ", s)
        s = re.sub(r"&[a-z]+;", " ", s)
        s = re.sub(r"[ \t]+", " ", s)
        texts.append(s)
    return "\n".join(texts)

def latest_filing(filings):
    """최신 증권신고서 1건 + 상태 판별 + 실적보고서 여부"""
    reg, perf = None, None
    for f in sorted(filings, key=lambda x: x.get("rcept_dt", ""), reverse=True):
        nm = f.get("report_nm", "")
        if "증권발행실적보고서" in nm and perf is None:
            perf = f
        if "증권신고서" in nm and "실적" not in nm and reg is None:
            reg = f
    status = "미제출"
    if reg:
        nm = reg["report_nm"]
        if "발행조건확정" in nm: status = "발행조건확정"
        elif "기재정정" in nm or "정정" in nm: status = "정정"
        else: status = "최초"
    return reg, perf, status

# ── 발췌기 (검증 규칙 구현) ──────────────────────────────────────────
def _after_correction(text):
    """'정정 후' 마지막 구간 우선 — 없으면 전체"""
    parts = re.split(r"정정\s*후", text)
    return parts[-1] if len(parts) > 1 else text

def _num(s):
    try: return float(str(s).replace(",", "").strip())
    except Exception: return None

def extract_registration(text):
    """증권신고서(최초/정정/확정 공통) 발췌"""
    out = {}
    t = _after_correction(text)

    m = re.search(r"희망공모가액[^\d]{0,20}([\d,]+)\s*원?\s*[~∼]\s*([\d,]+)\s*원", t) or \
        re.search(r"희망공모가액[^\d]{0,20}([\d,]+)\s*원?\s*[~∼]\s*([\d,]+)\s*원", text)
    if m: out["밴드"] = f"{m.group(1)}~{m.group(2)}"

    m = re.search(r"보통주\s*\|\s*([\d,]+)\s*\|\s*[\d,]+\s*\|\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|", t)
    if m:
        out["공모주식수"] = m.group(1)
        out["밴드하단가"] = m.group(2)
        out["공모금액"] = m.group(3)

    m = re.search(r"인수대가[^\n]{0,200}?([\d.]+)\s*%", t)
    if m: out["수수료율"] = m.group(1) + "%"
    m = re.search(r"대표주관회사\s*\|\s*([가-힣A-Za-z()㈜ ]+?)\s*\|[^\n]*?\|\s*([\d,]+)\s*\|\s*총액인수", t)
    if m: out["대표주관"], out["인수대가"] = m.group(1).strip(), m.group(2)
    co = re.findall(r"공동주관회사\s*\|\s*([가-힣A-Za-z()㈜ ]+?)\s*\|", t)
    if co: out["공동주관"] = ", ".join(x.strip() for x in co)

    m = re.search(r"(비교회사|유사회사|적용)\s*(P/?E R?|PER|PSR|EV/EBITDA)[^\d]{0,30}([\d.]+)\s*배?", t, re.I)
    if m: out["멀티플"] = f"{m.group(3)} ({m.group(2).upper().replace(' ','')})"

    m = re.search(r"수요예측\s*일시\s*\|?\s*(\d{4}년\s*\d{2}월\s*\d{2}일)[^\n]{0,40}?[~∼][^\n]{0,10}?(\d{4}년\s*\d{2}월\s*\d{2}일)", t)
    if m:
        f = lambda s: re.sub(r"(\d{4})년\s*(\d{2})월\s*(\d{2})일", r"\2-\3", s)
        out["수요예측기간"] = f"{f(m.group(1))}~{f(m.group(2))}"

    m = re.search(r"청약[기일]{0,2}일?\s*\|?\s*(\d{4})[.\s년]+(\d{2})[.\s월]+(\d{2})[^\n]{0,30}[~∼][^\n]{0,20}?(\d{2})[.\s월]+(\d{2})", t)
    if m: out["청약일정"] = f"{m.group(2)}-{m.group(3)}~{m.group(4)}-{m.group(5)}"

    # 확정본 전용
    m = re.search(r"확정공모가액[^\d]{0,20}([\d,]+)\s*원", t)
    if m: out["확정공모가"] = m.group(1)
    # 참여내역 합계: 건수/경쟁률 행의 마지막 숫자
    seg = re.search(r"수요예측\s*참여\s*내역[\s\S]{0,2500}", t)
    if seg:
        s = seg.group(0)
        m = re.search(r"건수\s*\|([^\n]+)", s)
        if m:
            nums = re.findall(r"[\d,]+", m.group(1))
            if nums: out["참여기관수"] = nums[-1]
        m = re.search(r"경쟁률\s*\|([^\n]+)", s)
        if m:
            nums = re.findall(r"[\d,]+\.\d+|[\d,]+", m.group(1))
            if nums: out["수요예측경쟁률"] = nums[-1]
    return out

def extract_performance(text):
    """증권발행실적보고서: (일반)청약경쟁률 + 상장예정일"""
    out = {}
    seg = re.search(r"청약\s*및\s*배정현황[\s\S]{0,1500}", text)
    if seg:
        m = re.search(r"일반투자자\s*\|([^\n]+)", seg.group(0))
        if m:
            nums = [_num(x) for x in re.findall(r"[\d,]+", m.group(1))]
            nums = [n for n in nums if n]
            # 일반투자자 행: 최초배정수량, 비율, 건수, 청약수량, 금액, 비율, 건수, 최종수량 ...
            if len(nums) >= 8:
                chung, bae = nums[3], nums[7]
                if bae: out["청약경쟁률"] = f"{chung/bae:,.2f}"
    m = re.search(r"상장\s*예정일[^\d]{0,20}(\d{4})[.\s년]+(\d{1,2})[.\s월]+(\d{1,2})", text)
    if m: out["상장예정일"] = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return out


def track_offerings(approved_names):
    """승인법인 → corp_code → 최신 신고서 → 발췌 → offering_master 갱신"""
    master = {}
    if os.path.exists(OFFERING_JSON):
        master = json.load(open(OFFERING_JSON, encoding="utf-8"))
    corp_map = dict(CORP_SEED)
    cm_path = os.path.join(BASE, "corp_map.json")
    if os.path.exists(cm_path):
        try: corp_map.update(json.load(open(cm_path, encoding="utf-8")).get("corp_map", {}))
        except Exception: pass

    changes = []
    for name in approved_names:
        code = corp_map.get(name)
        rec = master.get(name, {"회사명": name})
        if not code:
            rec["상태"] = "corp_code 미확보(수동확인)"
            master[name] = rec; continue
        try:
            filings = dart_list(code)
        except Exception as e:
            print(f"  [경고] {name} DART 조회 실패: {e}"); continue
        reg, perf, status = latest_filing(filings)
        new_rcept = reg["rcept_no"] if reg else None
        if new_rcept and rec.get("최신접수번호") != new_rcept:
            try:
                text = dart_document_text(new_rcept)
                rec.update(extract_registration(text))
                changes.append(f"{name}: 신고서 갱신({status}) {new_rcept}")
            except Exception as e:
                print(f"  [경고] {name} 발췌 실패: {e}")
            rec["최신접수번호"] = new_rcept
        if perf and rec.get("실적보고서") != perf["rcept_no"]:
            try:
                text = dart_document_text(perf["rcept_no"])
                rec.update(extract_performance(text))
                changes.append(f"{name}: 실적보고서 반영 {perf['rcept_no']}")
            except Exception as e:
                print(f"  [경고] {name} 실적 발췌 실패: {e}")
            rec["실적보고서"] = perf["rcept_no"]
        rec["상태"] = status if not perf else "청약완료·상장대기"
        rec["corp_code"] = code
        master[name] = rec

    json.dump(master, open(OFFERING_JSON, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    return master, changes


# ════════════════════════════════════════════════════════════════════
# [1] KIND 예심 수집 (kind_weekly 재사용 · 무인 실행용, input() 없음)
# ════════════════════════════════════════════════════════════════════
def collect_kind():
    import kind_weekly as kw
    import datetime as dt
    sess = requests.Session()
    try: sess.get(kw.REFERER, headers=kw.HEADERS, timeout=15)
    except Exception: pass
    fresh = kw.fetch_list(sess)
    master = kw.load_json(kw.MASTER, {"records": {}})
    store = master["records"]
    now = dt.datetime.now().isoformat(timespec="seconds")
    added, changed = [], []
    for rec in fresh:
        k = f"{rec['회사명']}||{rec['청구일']}"
        cur = "심사중" if kw.classify(rec["심사결과"]) == "신청" else "결과확정"
        if k not in store:
            store[k] = {**rec, "상태": cur, "최초수집": now, "최근확인": now,
                        "상태변경이력": [{"상태": cur, "시각": now}]}
            added.append(f"신규\t{rec['청구일']}\t{rec['회사명']}\t{rec['심사결과']}")
        else:
            it = store[k]; it["최근확인"] = now
            for fld in ("시장", "bizProcNo"):
                if rec.get(fld) and not it.get(fld): it[fld] = rec[fld]
            if it.get("상태") != cur or kw.nz(it.get("심사결과","")) != kw.nz(rec["심사결과"]):
                it["상태변경이력"] = it.get("상태변경이력", []) + [
                    {"상태": cur, "시각": now, "심사결과": rec["심사결과"]}]
                it["상태"], it["결과확정일"], it["심사결과"] = cur, rec["결과확정일"], rec["심사결과"]
                changed.append(f"상태변경\t{rec['청구일']}\t{rec['회사명']}\t-> {rec['심사결과']}")
    kw.save_json(kw.MASTER, master)

    fin = kw.load_json(kw.FINDATA, {})
    for k, v in kw.SEED_FIN.items():
        if k not in fin: fin[k] = {**v, "출처": "시드(검증완료)"}

    def result_date(rec):
        d = (rec.get("결과확정일") or "").strip()
        return d or kw.DATE_OVERRIDE.get(kw.fkey(rec["회사명"], rec["청구일"]), "")

    t_apply, t_appr, t_drop, need = [], [], [], []
    for rec in fresh:
        c = kw.classify(rec["심사결과"])
        if rec["상장유형"].replace(" ", "") == "재상장" and c in ("승인", "철회미승인"):
            continue
        if c == "신청": t_apply.append(rec)
        elif c == "승인" and result_date(rec).startswith(kw.YEAR): t_appr.append(rec)
        elif c == "철회미승인" and result_date(rec).startswith(kw.YEAR): t_drop.append(rec)
        else: continue
        if kw.fkey(rec["회사명"], rec["청구일"]) not in fin and rec.get("bizProcNo"):
            need.append(rec)
    for rec in need:
        try:
            d = kw.fetch_detail(sess, rec["bizProcNo"])
            fin[kw.fkey(rec["회사명"], rec["청구일"])] = {
                "매출액": d["매출액"], "순이익": d["순이익"], "자기자본": d["자기자본"],
                "업종": d["업종"], "단위": d["단위"],
                "유가": "Y" if rec.get("시장") == "유가" else "",
                "출처": f"KIND상세({TODAY})"}
        except Exception as e:
            print(f"  [경고] 상세 실패 {rec['회사명']}: {e}")
    kw.save_json(kw.FINDATA, fin)

    def build(rows, datefn):
        out = []
        for rec in rows:
            f = fin.get(kw.fkey(rec["회사명"], rec["청구일"]), {})
            unit = f.get("단위", "백만원"); cy = rec["청구일"][:4]
            base_year = "2024" if "FY24" in unit else (str(int(cy)-1) if cy.isdigit() else "")
            out.append({"일자": datefn(rec), "회사명": rec["회사명"],
                "유가": f.get("유가") or ("Y" if rec.get("시장")=="유가" else ""),
                "상장유형": rec["상장유형"], "심사결과": rec["심사결과"],
                "기준연도": base_year, "매출액": f.get("매출액",""),
                "순이익": f.get("순이익",""), "자기자본": f.get("자기자본",""),
                "업종": f.get("업종",""), "단위": unit,
                "대표주관사": kw.abbr(rec["상장주선인"])})
        out.sort(key=lambda r: r["일자"], reverse=True)
        return out

    DATA = {"asof": kw.TODAY, "year": kw.YEAR,
            "fin_basis": "청구일 직전 사업연도 · 별도/개별 재무제표 · 단위 백만원(별도 표기 시 USD)",
            "tables": {"신청": build(t_apply, lambda r: r["청구일"]),
                       "승인": build(t_appr, result_date),
                       "철회미승인": build(t_drop, result_date)}}
    DATA["counts"] = {k: len(v) for k, v in DATA["tables"].items()}
    html = kw.TEMPLATE.replace("__DATA__", json.dumps(DATA, ensure_ascii=False))
    open(kw.SITE, "w", encoding="utf-8").write(html)
    print(f"[KIND] 예심 갱신: 신규 {len(added)} · 변경 {len(changed)} · "
          f"표 {DATA['counts']}")
    return DATA, master


# ════════════════════════════════════════════════════════════════════
# [4] 3탭 엑셀 생성
# ════════════════════════════════════════════════════════════════════
V = "수집예정"; NA = "해당없음"

def _load_listing_seed():
    p = os.path.join(BASE, "listing_seed.json")
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else []

def build_excel(kind_data, kind_master, offering, listings):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    from collections import defaultdict

    FONT = "맑은 고딕"
    def F(bold=False, size=10, color="000000", italic=False):
        return Font(name=FONT, bold=bold, size=size, color=color, italic=italic)
    CEN = Alignment(horizontal="center", vertical="center", wrap_text=True)
    RIG = Alignment(horizontal="right", vertical="center", wrap_text=True)
    thin = Side(style="thin", color="BFBFBF")
    BORD = Border(left=thin, right=thin, top=thin, bottom=thin)
    def fill(h): return PatternFill("solid", fgColor=h)
    HDR = fill("1F3864"); SUB = fill("D9E1F2")
    C_GRAY="808080"; C_BLUE="2E5B9F"; C_GREEN="2E7D4F"; C_ORANGE="C55A11"; C_RED="9A3B3B"
    NUMCOLS = {4, 5, 16}

    wb = Workbook()

    # ── 탭1 예심 ──
    ws1 = wb.active; ws1.title = "1_예심"
    r = 1
    ws1.cell(r,1,"IPO 상장예비심사 현황").font = F(True,14); r += 1
    ws1.cell(r,1,f"기준일 {kind_data['asof']} · {kind_data['fin_basis']}").font = F(size=9,color="808080"); r += 2
    cols1 = ["일자","회사명","시장","상장유형","기준연도","매출액","순이익","자기자본","업종","대표주관사"]
    for block, label in [("신청","■ 심사 신청(진행중)"),("승인","■ 심사 승인"),("철회미승인","■ 철회·미승인")]:
        rows = kind_data["tables"][block]
        ws1.cell(r,1,f"{label}  ({len(rows)}건)").font = F(True,10,"1F3864")
        for c in range(1,len(cols1)+1): ws1.cell(r,c).fill = SUB
        r += 1
        for i,cn in enumerate(cols1,1):
            cell = ws1.cell(r,i,cn); cell.fill=HDR; cell.font=F(True,10,"FFFFFF"); cell.alignment=CEN; cell.border=BORD
        r += 1
        for row in rows:
            unit = row.get("단위","")
            vals = [row.get("일자",""), row.get("회사명",""),
                    "유가" if row.get("유가")=="Y" else "코스닥",
                    row.get("상장유형","") or row.get("심사결과",""),
                    f"FY{row['기준연도'][2:]}" if row.get("기준연도") else "",
                    row.get("매출액",""), row.get("순이익",""), row.get("자기자본",""),
                    row.get("업종",""), row.get("대표주관사","")]
            for i,v in enumerate(vals,1):
                cell = ws1.cell(r,i,v); cell.font=F(); cell.border=BORD
                cell.alignment = RIG if i in (6,7,8) else CEN
            r += 1
        r += 1
    for col,w in zip("ABCDEFGHIJ",[11,16,7,12,8,12,11,11,26,16]):
        ws1.column_dimensions[col].width = w

    # ── 탭2 공모~상장 ──
    ws2 = wb.create_sheet("2_공모_상장")
    r = 1
    ws2.cell(r,1,"공모 ~ 상장 현황 (2026)").font = F(True,14); r += 1
    ws2.cell(r,1,'출처: DART 증권신고서(최신 정정본 "정정 후")·증권발행실적보고서·KIND 신규상장 · 공모금액=밴드 하단(확정 시 확정총액) · 단위 백만원').font = F(size=9,color="808080"); r += 2
    COLS=[("","","기업명",C_GRAY),
     ("신고서 제출+정정 시",C_BLUE,"수요예측 기간",None),("신고서 제출+정정 시",C_BLUE,"공모가밴드(원)",None),
     ("신고서 제출+정정 시",C_BLUE,"공모주식수량",None),("신고서 제출+정정 시",C_BLUE,"공모금액(백만원)",None),
     ("신고서 제출+정정 시",C_BLUE,"밸류에이션 멀티플",None),
     ("확정공모가 공시 시",C_GREEN,"확정공모가(원)",None),("확정공모가 공시 시",C_GREEN,"수요예측 경쟁률",None),
     ("확정공모가 공시 시",C_GREEN,"참여기관수",None),
     ("신고서 제출+정정 시",C_BLUE,"청약일정",None),
     ("청약완료(실적보고서)",C_ORANGE,"청약경쟁률",None),("청약완료(실적보고서)",C_ORANGE,"상장예정일",None),
     ("상장 완료(KIND)",C_RED,"상장일",None),
     ("신고서 제출+정정 시",C_BLUE,"대표주관사",None),("신고서 제출+정정 시",C_BLUE,"공동주관",None),
     ("신고서 제출+정정 시",C_BLUE,"인수수수료(백만원)",None),("신고서 제출+정정 시",C_BLUE,"수수료율",None),
     ("","","진행상태",C_GRAY)]
    hr1 = r
    for i,(t1,c1,t2,c2) in enumerate(COLS,1):
        cell = ws2.cell(hr1,i,t1 or ""); cell.fill = fill(c1 if t1 else C_GRAY)
        cell.font=F(True,8.5,"FFFFFF"); cell.alignment=CEN; cell.border=BORD
    hr2 = r+1
    for i,(t1,c1,t2,c2) in enumerate(COLS,1):
        cell = ws2.cell(hr2,i,t2); cell.fill = fill(c1 if c1 else (c2 or C_GRAY))
        cell.font=F(True,9.5,"FFFFFF"); cell.alignment=CEN; cell.border=BORD
    ws2.row_dimensions[hr1].hidden = True
    ws2.row_dimensions[hr1].height = 0.1
    r = hr2+1
    NCOL = len(COLS)

    def section(label, count):
        nonlocal r
        ws2.cell(r,1,f"■ {label}  ({count}건)").font = F(True,10,"1F3864")
        for c in range(1,NCOL+1): ws2.cell(r,c).fill = SUB
        r += 1
    def write_row(row):
        nonlocal r
        for i,v in enumerate(row,1):
            cell = ws2.cell(r,i,v); cell.border = BORD
            if v == V: cell.font=F(size=9,color="A6A6A6",italic=True); cell.alignment=CEN
            elif v == NA: cell.font=F(size=9,color="BFBFBF"); cell.alignment=CEN
            else:
                cell.font=F(); cell.alignment = RIG if i in NUMCOLS and v != "" else CEN
        ws2.row_dimensions[r].height = 30
        r += 1
    def section(label, count):  # noqa: F811  (섹션 헤더: 통일 높이)
        nonlocal r
        ws2.cell(r,1,f"■ {label}  ({count}건)").font = F(True,10,"1F3864")
        for c in range(1,NCOL+1): ws2.cell(r,c).fill = SUB
        ws2.row_dimensions[r].height = 22
        r += 1

    # 상장 완료: 시드 + 신규상장 페이지 병합 (상장일은 페이지 기준 갱신)
    seed = {x["기업명"]: x for x in _load_listing_seed()}
    if listings:
        for l in listings:
            nm = l["회사명"]
            spac = ("스팩" in nm or "스펙" in nm) and "합병" not in l.get("상장유형","")
            if nm in seed:
                seed[nm]["상장일"] = l["상장일"]
            else:
                seed[nm] = {"기업명": nm, "상장일": l["상장일"],
                            "진행상태": "상장완료" + ("(스팩합병)" if "합병" in l.get("상장유형","") else "")}
    FIELDS = ["기업명","수요예측기간","밴드","공모주식수","공모금액","멀티플","확정공모가",
              "수요예측경쟁률","참여기관수","청약일정","청약경쟁률","상장예정일","상장일",
              "대표주관","공동주관","인수수수료","수수료율","진행상태"]
    listed_rows = sorted(seed.values(),
        key=lambda x: x.get("상장일","") or "0", reverse=True)
    section("상장 완료 (2026)", len(listed_rows))
    for x in listed_rows:
        write_row([x.get(f, V if f not in ("공동주관","상장예정일") else "") for f in FIELDS])
    r += 1

    # 공모 진행: offering_master (상장일 확정된 건은 위 섹션으로 승격)
    prog = []
    for name, rec in offering.items():
        if name in seed and seed[name].get("상장일"):
            continue
        prog.append(rec)
    order = {"청약완료·상장대기":0,"발행조건확정":1,"정정":2,"최초":3,"미제출":9}
    prog.sort(key=lambda x: (order.get(x.get("상태",""),5), x.get("수요예측기간","") or "zz"))
    section("공모 진행 (예심 승인법인)", len(prog))
    for x in prog:
        write_row([x.get("회사명",""), x.get("수요예측기간",V), x.get("밴드",V),
                   x.get("공모주식수",V), x.get("공모금액",V), x.get("멀티플",V),
                   x.get("확정공모가",""), x.get("수요예측경쟁률",""), x.get("참여기관수",""),
                   x.get("청약일정",V), x.get("청약경쟁률",""), x.get("상장예정일",""),
                   "", x.get("대표주관",V), x.get("공동주관",""),
                   x.get("인수대가",V), x.get("수수료율",V),
                   {"미제출":"신고서 대기"}.get(x.get("상태"), x.get("상태",""))])
    r += 1
    for n in ['※ 상장 완료 = KIND 신규상장 페이지 기준(스팩합병 포함) · 스팩 공모상장은 밴드·밸류에이션 등 해당없음(공모가 2,000원 고정).',
              '※ 기재정정 신고서 내 정정 전·후 병존 → 자동수집은 "정정 후" 값만 취함.',
              '※ 청약경쟁률=일반투자자 청약수량÷최종배정수량 · "MM-DD~"는 종료일 자동수집 예정.']:
        ws2.cell(r,1,n).font = F(size=8,color="808080"); r += 1
    ws2.freeze_panes = f"B{hr2+1}"
    for i,w in enumerate([15,11,15,11,12,13,10,9,8,11,9,11,11,7,7,10,7,13],1):
        ws2.column_dimensions[get_column_letter(i)].width = w
    ws2.row_dimensions[hr2].height = 30

    # ── 탭3 분석 ──
    ws3 = wb.create_sheet("3_분석")
    r = 1
    ws3.cell(r,1,f"IPO 시장 분석 ({kind_data['year']})").font = F(True,14); r += 1
    ws3.cell(r,1,"승인율=결과확정 시점 기준 · 상장=KIND 신규상장 페이지 기준(스팩·합병 포함)").font = F(size=9,color="808080"); r += 2

    agg = defaultdict(lambda: defaultdict(int))
    for rec in kind_master["records"].values():
        c = {"청구서접수":"신청","심사승인":"승인","심사철회":"철회","심사미승인":"철회"}.get(
            (rec.get("심사결과") or "").replace(" ",""), "")
        cd = (rec.get("청구일") or "")[:7]
        rd = ((rec.get("결과확정일") or rec.get("청구일")) or "")[:7]
        if cd.startswith(kind_data["year"]): agg[cd]["청구"] += 1
        if rd.startswith(kind_data["year"]):
            if c == "승인": agg[rd]["승인"] += 1
            if c == "철회": agg[rd]["철회"] += 1
    for l in (listings or []):
        m = (l.get("상장일") or "")[:7]
        if m.startswith(kind_data["year"]): agg[m]["상장"] += 1
    if not listings:
        for x in _load_listing_seed():
            m = (x.get("상장일") or "")[:7]
            if m.startswith(kind_data["year"]): agg[m]["상장"] += 1

    ws3.cell(r,1,"① 월별 예심·상장 현황 및 승인율").font = F(True,10,"1F3864")
    for c in range(1,7): ws3.cell(r,c).fill = SUB
    r += 1
    for i,cn in enumerate(["월","청구","승인","철회·미승인","상장","예심 승인율"],1):
        cell = ws3.cell(r,i,cn); cell.fill=HDR; cell.font=F(True,10,"FFFFFF"); cell.alignment=CEN; cell.border=BORD
    ds = r+1; r += 1
    for m in sorted(agg):
        a = agg[m]
        ws3.cell(r,1,m); ws3.cell(r,2,a["청구"]); ws3.cell(r,3,a["승인"])
        ws3.cell(r,4,a["철회"]); ws3.cell(r,5,a["상장"])
        ws3.cell(r,6,f'=IF((C{r}+D{r})=0,"-",C{r}/(C{r}+D{r}))')
        for c in range(1,7):
            cell = ws3.cell(r,c); cell.font=F(); cell.border=BORD; cell.alignment=CEN
            if c == 6: cell.number_format = "0.0%"
        r += 1
    ws3.cell(r,1,"합계").font=F(True); ws3.cell(r,1).alignment=CEN
    for c,col in zip(range(2,6),"BCDE"):
        cell = ws3.cell(r,c,f"=SUM({col}{ds}:{col}{r-1})"); cell.font=F(True); cell.alignment=CEN
    cell = ws3.cell(r,6,f'=IF((C{r}+D{r})=0,"-",C{r}/(C{r}+D{r}))')
    cell.font=F(True); cell.number_format="0.0%"; cell.alignment=CEN
    for c in range(1,7):
        ws3.cell(r,c).fill = fill("FCE4D6"); ws3.cell(r,c).border = BORD
    r += 2

    ws3.cell(r,1,"② 주관사별 점유율 (공모 확보분)").font = F(True,10,"1F3864")
    for c in range(1,4): ws3.cell(r,c).fill = SUB
    r += 1
    for i,cn in enumerate(["대표주관사","건수","공모금액(백만원)"],1):
        cell = ws3.cell(r,i,cn); cell.fill=HDR; cell.font=F(True,10,"FFFFFF"); cell.alignment=CEN; cell.border=BORD
    r += 1
    share = defaultdict(lambda: [0,0.0])
    src = list(seed.values()) + list(offering.values())
    for x in src:
        lead = (x.get("대표주관") or "").strip()
        if not lead or lead in (V, NA): continue
        amt = str(x.get("공모금액","")).replace(",","").split(" ")[0].split("(")[0]
        try: a = float(amt)
        except Exception: a = 0.0
        share[lead][0] += 1; share[lead][1] += a
    for lead,(n,a) in sorted(share.items(), key=lambda x:-x[1][1]):
        ws3.cell(r,1,lead); ws3.cell(r,2,n); ws3.cell(r,3,f"{a:,.0f}" if a else "")
        for c in range(1,4):
            cell = ws3.cell(r,c); cell.font=F(); cell.border=BORD; cell.alignment=CEN
        r += 1
    for col,w in zip("ABCDEF",[12,10,16,10,10,12]): ws3.column_dimensions[col].width = w

    wb.save(XLSX_OUT)
    print(f"[EXCEL] {os.path.basename(XLSX_OUT)} 생성 완료 "
          f"(상장 {len(listed_rows)} · 진행 {len(prog)})")


# ════════════════════════════════════════════════════════════════════
# [5] 원장 CSV 내보내기 (분석·가공용 · 매 실행 시 최신으로 재생성)
# ════════════════════════════════════════════════════════════════════
def export_ledgers(kind_master, offering, listings):
    import csv
    # ── events.csv : 이벤트 원장 (일자·회사·이벤트·상세) ──
    ev = []
    for rec in kind_master["records"].values():
        nm = rec.get("회사명", ""); ty = rec.get("상장유형", "")
        if rec.get("청구일"):
            ev.append([rec["청구일"], nm, "예심청구", ty])
        res = (rec.get("심사결과") or "").replace(" ", "")
        rd = (rec.get("결과확정일") or "").strip()
        if rd and res and res != "청구서접수":
            label = {"심사승인": "예심승인", "심사철회": "심사철회",
                     "심사미승인": "심사미승인", "상장승인": "상장승인"}.get(res, res)
            ev.append([rd, nm, label, ty])
    for l in (listings or []):
        ev.append([l.get("상장일", ""), l.get("회사명", ""), "상장",
                   l.get("상장유형", "")])
    if not listings:
        for x in _load_listing_seed():
            if x.get("상장일", "").startswith("20"):
                ev.append([x["상장일"], x["기업명"], "상장", x.get("진행상태", "")])
    for name, rec in (offering or {}).items():
        rn = rec.get("최신접수번호") or ""
        if len(rn) >= 8:
            ev.append([f"{rn[:4]}-{rn[4:6]}-{rn[6:8]}", name,
                       f"신고서({rec.get('상태','')})",
                       rec.get("확정공모가", "") or rec.get("밴드", "")])
        pr = rec.get("실적보고서") or ""
        if len(pr) >= 8:
            ev.append([f"{pr[:4]}-{pr[4:6]}-{pr[6:8]}", name, "발행실적보고",
                       rec.get("청약경쟁률", "")])
    ev = sorted([e for e in ev if e[0]], key=lambda x: x[0])
    with open(os.path.join(BASE, "events.csv"), "w",
              newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f); w.writerow(["일자", "회사명", "이벤트", "상세"]); w.writerows(ev)

    # ── offerings.csv : 공모 원장 (기업 1행 플랫 테이블) ──
    FIELDS = ["기업명", "진행상태", "수요예측기간", "밴드", "공모주식수", "공모금액",
              "멀티플", "확정공모가", "수요예측경쟁률", "참여기관수", "청약일정",
              "청약경쟁률", "상장예정일", "상장일", "대표주관", "공동주관",
              "인수수수료", "수수료율"]
    seed = {x["기업명"]: dict(x) for x in _load_listing_seed()}
    if listings:
        for l in listings:
            nm = l["회사명"]
            seed.setdefault(nm, {"기업명": nm, "진행상태": "상장완료"})
            seed[nm]["상장일"] = l["상장일"]
    rows = list(seed.values())
    for name, rec in (offering or {}).items():
        if name in seed and seed[name].get("상장일", "").startswith("20"):
            continue
        d = dict(rec); d["기업명"] = name
        d["진행상태"] = rec.get("상태", ""); d["인수수수료"] = rec.get("인수대가", "")
        rows.append(d)
    with open(os.path.join(BASE, "offerings.csv"), "w",
              newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f); w.writerow(FIELDS)
        for x in rows: w.writerow([x.get(k, "") for k in FIELDS])
    print(f"[LEDGER] events.csv {len(ev)}행 · offerings.csv {len(rows)}행")


# ════════════════════════════════════════════════════════════════════
# 메인
# ════════════════════════════════════════════════════════════════════
def main():
    print("=" * 62)
    print(f" IPO 통합 일일 자동화  ({TODAY})")
    print("=" * 62)

    # [1] KIND 예심 + index.html
    kind_data, kind_master = collect_kind()

    # [2] KIND 신규상장 (상장일 확정 소스)
    sess = requests.Session()
    listings = fetch_new_listings(sess)
    if listings is not None:
        print(f"[KIND] 신규상장 페이지: {len(listings)}건")
    else:
        if os.path.exists(LISTING_JSON):
            listings = json.load(open(LISTING_JSON, encoding="utf-8"))
            print(f"[KIND] 신규상장 접속 실패 → 기존 정본 사용({len(listings)}건)")
        else:
            listings = []
            print("[KIND] 신규상장 접속 실패 → 시드(listing_seed.json)로 대체")

    # [2-b] 스팩합병 상장 병합 (신규상장 페이지에는 안 잡히므로 예심 master에서 보강)
    #   기준: 심사결과='상장승인' & 상장유형에 '스팩'+'합병' & 당해연도
    have = {l["회사명"] for l in listings}
    spac_added = 0
    for rec in kind_master["records"].values():
        ltype = (rec.get("상장유형") or "").replace(" ", "")
        res = (rec.get("심사결과") or "").replace(" ", "")
        rd = (rec.get("결과확정일") or "")
        if res == "상장승인" and "스팩" in ltype and "합병" in ltype \
                and rd.startswith(str(datetime.date.today().year)):
            nm = rec["회사명"]
            if nm not in have:
                listings.append({"회사명": nm, "상장일": rd,
                                 "상장유형": "스팩합병", "시장": "코스닥"})
                have.add(nm); spac_added += 1
    if spac_added:
        print(f"[KIND] 스팩합병 상장 병합: +{spac_added}건 "
              f"(합계 {len(listings)}건)")
    json.dump(listings, open(LISTING_JSON, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    # [3] DART 공모 추적 (승인법인, 재상장 제외)
    approved = []
    for rec in kind_master["records"].values():
        if (rec.get("심사결과","").replace(" ","") == "심사승인"
                and "재상장" not in (rec.get("상장유형") or "")
                and (rec.get("결과확정일","") or "").startswith(kind_data["year"])):
            approved.append(rec["회사명"])
    if not DART_API_KEY:
        print("[DART] API 키 없음 → 공모 추적 생략 (환경변수 DART_API_KEY 설정 필요)")
        offering = json.load(open(OFFERING_JSON, encoding="utf-8")) \
                   if os.path.exists(OFFERING_JSON) else {}
    else:
        offering, ch = track_offerings(approved)
        print(f"[DART] 공모 추적: {len(offering)}건 · 변경 {len(ch)}건")
        for c in ch: print("   -", c)

    # [4] 3탭 엑셀
    build_excel(kind_data, kind_master, offering, listings)

    # [5] 원장 CSV (분석·가공용)
    export_ledgers(kind_master, offering, listings)
    print("\n[완료] IPO_analysis.xlsx / index.html / events.csv / offerings.csv 갱신")

if __name__ == "__main__":
    main()
