# -*- coding: utf-8 -*-
"""
ci_probe.py — GitHub Actions 러너에서 KIND·DART 접속 가능 여부 실측
--------------------------------------------------------------------
목적: 본 자동화(ipo_daily.py)를 켜기 전에, 클라우드 러너(미국 IP)에서
      kind.krx.co.kr / opendart.fss.or.kr 이 실제로 열리는지 확인한다.
      하나라도 막히면 GitHub Actions 대신 PC 스케줄러로 방향을 튼다.

종료코드: 접속 성공 0 / 실패 1  (워크플로가 빨강/초록으로 표시)
"""
import sys, json, os
import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": "https://kind.krx.co.kr/listinvstg/listingcompany.do",
}

def check(name, method, url, **kw):
    try:
        r = requests.request(method, url, headers=HEADERS, timeout=25, **kw)
        body = (r.text or "")[:120].replace("\n", " ")
        ok = r.status_code == 200
        print(f"[{'OK ' if ok else 'FAIL'}] {name:22} HTTP {r.status_code}  {body!r}")
        return ok
    except Exception as e:
        print(f"[FAIL] {name:22} EXC {type(e).__name__}: {e}")
        return False

def main():
    print("=" * 70)
    print(" CI 접속 실측 — KIND / DART")
    print("=" * 70)
    results = []

    # 1) KIND 예심 목록 엔드포인트 (POST)
    results.append(check(
        "KIND 예심목록", "POST",
        "https://kind.krx.co.kr/listinvstg/listinvstgcom.do",
        data={"method": "searchListInvstgComList"}))

    # 2) KIND 신규상장 페이지 (GET)
    results.append(check(
        "KIND 신규상장", "GET",
        "https://kind.krx.co.kr/listinvstg/listingcompany.do"))

    # 3) DART OpenAPI (키가 있으면 실제 호출, 없으면 도메인 헬스만)
    key = os.environ.get("DART_API_KEY", "")
    if key:
        r_ok = check(
            "DART API(list)", "GET",
            "https://opendart.fss.or.kr/api/list.json",
            params={"crtfc_key": key, "page_count": "1"})
        results.append(r_ok)
    else:
        print("[SKIP] DART API 키 미설정 → 도메인 접속만 확인")
        results.append(check(
            "DART 도메인", "GET", "https://opendart.fss.or.kr/"))

    print("-" * 70)
    passed = sum(results)
    print(f"결과: {passed}/{len(results)} 통과")
    if passed == len(results):
        print(">>> 전부 접속 OK — GitHub Actions 자동화 진행 가능")
        sys.exit(0)
    else:
        print(">>> 일부 차단 — GitHub Actions 부적합. PC 스케줄러 권장")
        sys.exit(1)

if __name__ == "__main__":
    main()
