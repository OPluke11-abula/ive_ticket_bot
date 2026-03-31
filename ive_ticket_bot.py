import re
import time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

TARGET_URL = "https://tixcraft.com/activity/detail/26_ive"
TARGET_DATE = "2026/09/12"
TARGET_TIME = "18:00"

# 預設搶票張數 (數量)
TICKET_QTY = 2

# 建立優先順序名單 (由高到低)
# 由於目前未公布詳細的區域名稱，我們使用票價直接作為搜尋特徵
# 每一個項目是 (區域名稱特徵, 價格)，這裡字首留空代表「任何包含該價格名稱的區域」
PRIORITY_ZONES = [
    ("", "3880"),
    ("", "2800"),
    ("", "2300"),
    ("", "800"),
    ("", "400")
]

def init_driver():
    options = Options()
    # 保持瀏覽器較穩定不要閃退
    options.add_experimental_option("detach", True)
    # 取消 自動軟體控制 的提示
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option('useAutomationExtension', False)
    
    driver = webdriver.Chrome(options=options)
    
    # 基本反爬蟲變數隱藏
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
      "source": """
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        })
      """
    })
    return driver

def snatch_ticket(driver):
    print("🚀 開始進入拓元售票系統...")
    driver.get(TARGET_URL)
    
    # 若還沒登入，可以趁這時登入
    print("⚠️ 請確認已在瀏覽器中登入拓元，登入後腳本會自動持續偵測場次開賣狀況...")

    # ==========================
    # 第零階段：點擊「立即購票」進入場次列表
    # ==========================
    try:
        # 根據拓元的新架構，立即購票是一個會開新分頁的超連結
        print("🔍 尋找「立即購票」按鈕...")
        # 等待一下確保 DOM 有載入
        time.sleep(1.5)
        buy_tab_link = driver.find_element(By.XPATH, "//li[contains(@class, 'buy')]//a | //a[.//div[contains(text(), '立即購票')]]")
        game_url = buy_tab_link.get_attribute("href")
        if game_url:
            print(f"✅ 找到場次列表連結，前往: {game_url}")
            driver.get(game_url) # 直接在同一個分頁跳轉，避免開新分頁的麻煩
        else:
            buy_tab_link.click()
            time.sleep(1)
            # 如果真的開了新分頁，把控制權移過去
            if len(driver.window_handles) > 1:
                driver.switch_to.window(driver.window_handles[-1])
    except Exception as e:
        print(f"⚠️ 找不到「立即購票」標籤，可能已經在場次列表頁面，或是頁面正在載入... （繼續往下執行）")

    # ==========================
    # 第一階段：等待並點擊場次的「立即訂購」
    # ==========================
    entered_area_page = False
    
    while not entered_area_page:
        try:
            # 尋找場次表格
            rows = driver.find_elements(By.TAG_NAME, "tr")
            found_target_row = None
            
            for row in rows:
                if TARGET_DATE in row.text and TARGET_TIME in row.text:
                    found_target_row = row
                    break
                    
            if not found_target_row:
                print(f"[{time.strftime('%H:%M:%S')}] ⏳ 找不到場次 {TARGET_DATE} {TARGET_TIME} 的資料，重新整理中...")
                time.sleep(1)
                driver.refresh()
                continue
                
            # 在該行裡面尋找「立即訂購」按鈕
            try:
                # 根據截圖，它是 <button type="button" class="btn btn-primary text-bold m-0" data-href="...">立即訂購</button>
                buy_btn = found_target_row.find_element(By.XPATH, ".//button[contains(text(), '立即訂購')] | .//button[@data-href]")
                
                # 雙重確認它是立即訂購按鈕
                if "立即訂購" in buy_btn.text:
                    print(f"[{time.strftime('%H:%M:%S')}] ✅ 找到目標場次的『立即訂購』按鈕！準備點擊...")
                    
                    # 針對 <button data-href> 點擊
                    buy_btn.click()
                    entered_area_page = True
                    
                    # 給瀏覽器一點時間載入區域選擇畫面
                    time.sleep(1.5) 
                else:
                    raise Exception("Not yet buyable")
                    
            except Exception:
                # 尚未出現立即訂購按鈕 (可能還在「開賣倒數」)
                print(f"[{time.strftime('%H:%M:%S')}] ⏳ 指定場次目前尚無『立即訂購』按鈕 (距開賣時間可能還沒到)，重新整理...")
                time.sleep(1)
                driver.refresh()
                
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] 等待開賣畫面出現錯誤，重新嘗試: {e}")
            time.sleep(1)
            driver.refresh()

    # ==========================
    # 第二階段：進入區域選擇畫面，開始配對並點擊目標優先區域
    # ==========================
    print("🚀 已成功進入區域選擇畫面，開始配對優先名單搶票！")
    
    while True:
        try:
            # 嘗試確保切換到「電腦配位」模式 (遵循 Tixcraft 新流程)
            try:
                auto_assign_tabs = driver.find_elements(By.XPATH, "//a[contains(text(), '電腦配位')] | //button[contains(text(), '電腦配位')] | //li[contains(text(), '電腦配位')]")
                for tab in auto_assign_tabs:
                    if tab.is_displayed():
                        # 若尚未處於 active 狀態，或是可以點擊，就嘗試點擊
                        parent_class = tab.find_element(By.XPATH, "..").get_attribute('class') or ""
                        tab_class = tab.get_attribute('class') or ""
                        if 'active' not in parent_class and 'active' not in tab_class:
                            try:
                                tab.click()
                                time.sleep(0.3) # 稍微等待切換
                            except:
                                pass
                        break
            except Exception:
                pass

            # 拓元的區域按鈕通常是 <a> 標籤，我們抓出清單上所有的 a
            elements = driver.find_elements(By.TAG_NAME, "a")
            
            for target_area, target_price in PRIORITY_ZONES:
                for el in elements:
                    try:
                        text = el.text.strip().replace('\n', ' ')
                        
                        # 檢查 區域、價格 是否同時出現在此按鈕文字內
                        if target_area in text and target_price in text:
                            # 檢查是否已賣完
                            if "售完" in text or "Sold out" in text:
                                continue
                                
                            # 解析此區域的剩餘數量，例如是否有 "剩餘 X" 的字眼
                            qty = "充足(或熱賣中)"
                            qty_match = re.search(r'剩餘\D*(\d+)', text)
                            if qty_match:
                                qty = qty_match.group(1)
                                
                            # 輸出符合使用者要求的訊息格式
                            print(f"🎉 找到票了！ 位置: {target_area} ({target_price}) | 剩餘數量: {qty}")
                            
                            # 點擊該區域
                            el.click()
                            print("✅ 已點擊進入該區域，準備選取張數並輸入驗證碼！")
                            
                            # 嘗試自動選張數與打勾「我同意」，進一步加速流程 (如 PDF 所述需確認張數)
                            try:
                                # 等待選單出現 (使用 tag name select)
                                WebDriverWait(driver, 2).until(
                                    lambda d: d.find_element(By.TAG_NAME, "select")
                                )
                                selects = driver.find_elements(By.TAG_NAME, "select")
                                if selects:
                                    # 抓取對應區域的 select
                                    select_elem = selects[0]
                                    options = select_elem.find_elements(By.TAG_NAME, "option")
                                    # 選擇第 TICKET_QTY 個或最後一個
                                    target_qty_idx = min(TICKET_QTY, len(options) - 1)
                                    if target_qty_idx > 0:
                                        options[target_qty_idx].click()
                                        print(f"✅ 自動選擇 {options[target_qty_idx].text} 張票")
                                
                                # 嘗試打勾「我同意本站購票須知」 (TicketForm_agree)
                                agree_checkbox = driver.find_elements(By.ID, "TicketForm_agree")
                                if agree_checkbox and not agree_checkbox[0].is_selected():
                                    driver.execute_script("arguments[0].click();", agree_checkbox[0])
                                    print("✅ 已自動打勾同意購票須知")
                            except Exception as e:
                                print(f"⚠️ 自動選張數/打勾發生錯誤或畫面不同，請準備手動處理。({e})")
                                
                            return True
                    except Exception:
                        continue
                        
            # 若第一輪全部跑完都沒票，就等待之後重整頁面，期待有人退票清票
            print(f"[{time.strftime('%H:%M:%S')}] 🔄 目前沒有符合名單內的票，重新整理...")
            time.sleep(1) # 短暫等待避免請求過快被鎖
            driver.refresh()
            
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] 區域搜尋出現錯誤，重新嘗試: {e}")
            time.sleep(1)
            driver.refresh()

if __name__ == "__main__":
    driver = init_driver()
    try:
        success = snatch_ticket(driver)
        if success:
            print("🎫 已經進入選票畫面！ 請快速手動完成 【選擇張數】 與 【輸入驗證碼】！")
            
            # 使用者自己處理驗證碼等，保持瀏覽器不關閉
            while True:
                time.sleep(100)
    except KeyboardInterrupt:
        print("🛑 停止自動搶票。")
    except Exception as e:
        print(f"腳本中斷: {e}")
