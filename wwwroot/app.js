const roomId = new URLSearchParams(location.search).get("id");

// ================= 상태 관리 캐시 =================
let currentRoomData = null;
let editingParticipantId = null; // 현재 인라인 수정 중인 참여자 ID
let previewedYogiyoLink = null;
let isCartCollapsed = false;
const orderOwnerToken = getOrderOwnerToken();

function getOrderOwnerToken() {
    const storageKey = "lunchapp-order-owner";
    let token = localStorage.getItem(storageKey);
    if (!token) {
        token = crypto.randomUUID?.() || createFallbackUuid();
        localStorage.setItem(storageKey, token);
    }
    return token;
}

function createFallbackUuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, character => {
        const random = Math.floor(Math.random() * 16);
        const value = character === "x" ? random : (random & 0x3) | 0x8;
        return value.toString(16);
    });
}

function getOwnedOrderIds() {
    return new Set(JSON.parse(localStorage.getItem("lunchapp-owned-orders") || "[]"));
}

function rememberOwnedOrder(id) {
    const ids = getOwnedOrderIds();
    ids.add(id);
    localStorage.setItem("lunchapp-owned-orders", JSON.stringify([...ids]));
}

function forgetOwnedOrder(id) {
    const ids = getOwnedOrderIds();
    ids.delete(id);
    localStorage.setItem("lunchapp-owned-orders", JSON.stringify([...ids]));
}

// ================= SignalR 연결 수립 및 실시간 리스너 정의 =================
let connection = new signalR.HubConnectionBuilder()
    .withUrl("/hub")
    .build();

connection.on("Update", () => {
    // 실시간 방 안 동기화 또는 대시보드 리스트 비동기 갱신
    if (roomId) {
        initRoom();
    } else {
        loadRooms();
    }
});

connection.start().catch(err => {
    console.error("SignalR Connection Error: ", err.toString());
});

// 뒤로가기(pageshow) 시 캐시 복원 대응
window.addEventListener("pageshow", (event) => {
    if (!roomId) {
        loadRooms();
    } else {
        initRoom();
    }
});

// ================= 이름 텍스트 정규식 유효성 검사 (한글, 영문, 공백만 허용) =================
function isValidName(name) {
    if (!name || name.trim() === "") return false;
    const regex = /^[a-zA-Z가-힣ㄱ-ㅎㅏ-ㅣ\s]+$/;
    return regex.test(name);
}

function toggleCreateRoomForm(forceOpen) {
    const panel = document.getElementById("createRoomPanel");
    const toggle = document.getElementById("createRoomToggle");
    if (!panel || !toggle) return;

    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : panel.hidden;
    panel.hidden = !shouldOpen;
    toggle.innerText = shouldOpen ? "－ 닫기" : "＋ 새 주문방";

    if (shouldOpen) {
        const hostInput = document.getElementById("roomHost");
        if (hostInput && !hostInput.value) {
            hostInput.value = localStorage.getItem("name") || "";
        }
        document.getElementById("roomTitle")?.focus();
    }
}

// ================= 방 목록 로드 =================
async function loadRooms() {
    try {
        const res = await fetch("/api/rooms");
        if (res.ok) {
            const rooms = await res.json();
            renderRoomList(rooms);
        }
    } catch (e) {
        console.error("방 목록을 불러오지 못했습니다.", e);
    }
}

// ================= 방 생성 =================
async function createRoom() {
    const titleEl = document.getElementById("roomTitle");
    const hostEl = document.getElementById("roomHost");
    const passwordEl = document.getElementById("roomPassword");
    const linkEl = document.getElementById("roomLink");

    const title = titleEl.value.trim();
    const host = hostEl.value.trim();
    const password = passwordEl.value.trim();
    const link = linkEl.value.trim();

    if (!title || !host || !password) {
        alert("방 제목, 방장 이름, 삭제 비밀번호는 필수 입력 항목입니다.");
        return;
    }

    if (!isValidName(host)) {
        alert("방장 이름에는 문자(한글, 영문)만 입력할 수 있습니다. (숫자/특수문자 제한)");
        return;
    }
    if (!/^\d{4}$/.test(password)) {
        alert("삭제 비밀번호는 숫자 4자리로 입력해 주십시오.");
        return;
    }

    // 방장 사용자 이름을 로컬 스토리지에 자동 저장하여 UX 개선
    localStorage.setItem("name", host);
    const createButton = document.getElementById("createRoomBtn");
    if (createButton) {
        createButton.disabled = true;
        createButton.innerText = "주문방 만드는 중…";
    }

    try {
        const res = await fetch("/api/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, host, link, password })
        });

        if (res.ok) {
            const room = await res.json();
            location.href = `room.html?id=${room.id}`;
        } else {
            const errMsg = await res.text();
            alert(errMsg || "방 생성 도중 웹 서버 에러가 발생했습니다.");
        }
    } catch (e) {
        console.error(e);
        alert("네트워크 연결 결함으로 방을 만들지 못했습니다.");
    } finally {
        if (createButton) {
            createButton.disabled = false;
            createButton.innerText = "주문방 만들기";
        }
    }
}

// ================= 대시보드 기차 목록 렌더링 =================
function renderRoomList(rooms) {
    const list = document.getElementById("roomList");
    const summary = document.getElementById("roomSummary");
    if (!list) return;
    list.innerHTML = "";

    const activeRooms = rooms.filter(room => !room.isOrderClosed).length;
    if (summary) {
        summary.innerText = `진행 중 ${activeRooms}개 · 전체 ${rooms.length}개`;
    }

    if (rooms.length === 0) {
        list.innerHTML = `
            <div class="empty-list-msg">
                <strong>🚂 아직 주문방이 없습니다.</strong>
                <span>첫 주문방을 만들어 함께 메뉴를 모아보세요.</span>
                <button type="button" onclick="toggleCreateRoomForm(true)">첫 주문방 만들기</button>
            </div>
        `;
        return;
    }

    [...rooms]
        .sort((left, right) => Number(left.isOrderClosed) - Number(right.isOrderClosed))
        .forEach(r => {
        const div = document.createElement("div");
        div.className = `room-card ${r.isOrderClosed ? "closed-room" : "active-room"}`;
        const participants = r.participants || [];
        const totalAmount = participants.reduce((sum, participant) => sum + (Number(participant.amount) || 0), 0);
        const statusText = r.isOrderClosed ? "주문 마감" : "주문 받는 중";
        const statusClass = r.isOrderClosed ? "closed" : "open";

        // 카드 클릭 시에도 방 입장
        div.onclick = () => location.href = `room.html?id=${r.id}`;

        div.innerHTML = `
            <div class="room-info">
                <div class="room-title-line">
                    <div class="title">${escapeHtml(r.title)}</div>
                    <span class="room-status ${statusClass}">${statusText}</span>
                </div>
                <div class="meta">
                    <span>👤 방장: ${escapeHtml(r.host)}</span>
                    <span>👥 ${participants.length}명</span>
                    <span>💸 ${totalAmount.toLocaleString()}원</span>
                </div>
            </div>
            <div class="room-actions">
                ${r.link ? `<a href="${escapeHtml(r.link)}" target="_blank" class="delivery-btn" onclick="event.stopPropagation();">🍗 배달 링크</a>` : ""}
                <button class="join-btn" onclick="event.stopPropagation(); location.href = 'room.html?id=${r.id}';">참여하기 ➔</button>
            </div>
        `;

        list.appendChild(div);
    });
}

// ================= 방 정보 초기 로드 =================
async function initRoom() {
    if (!roomId) return;

    try {
        const res = await fetch(`/api/rooms/${roomId}`, {
            headers: { "X-Order-Owner": orderOwnerToken }
        });
        if (res.status === 404) {
            alert("존재하지 않거나 삭제된 방입니다.");
            location.href = "/";
            return;
        }
        
        if (res.ok) {
            const room = await res.json();
            currentRoomData = room; // 캐시 저장

            // 방 타이틀 표기
            document.getElementById("roomTitle").innerText = room.title;

            // 방 타이틀 옆 배달 주문 링크 버튼 구현
            const linkBox = document.getElementById("deliveryLinkBox");
            if (linkBox) {
                if (room.link) {
                    linkBox.innerHTML = `<a href="${escapeHtml(room.link)}" target="_blank" class="delivery-badge-link">🛒 배달 링크 바로가기 ➔</a>`;
                } else {
                    linkBox.innerHTML = "";
                }
            }

            loadYogiyoPreview(room.link);

            // 방장 영역 갱신
            const hostBox = document.getElementById("hostBox");
            if (hostBox) {
                hostBox.innerText = `👑 방장: ${room.host}`;
            }

            // 이름 입력창 로컬 스토리지 초기 바인딩 및 이벤트 정의
            const nameEl = document.getElementById("name");
            if (nameEl) {
                if (!nameEl.value) {
                    nameEl.value = localStorage.getItem("name") || "";
                }

                nameEl.oninput = () => {
                    localStorage.setItem("name", nameEl.value);
                    checkDeleteButtonPermission(room);
                };
            }

            // 방 삭제 제어권 확인
            checkDeleteButtonPermission(room);
            renderOrderStatus(room);

            // 참여 멤버 리스트 렌더링
            render(room);
        }
    } catch (e) {
        console.error("방 정보를 가져오지 못했습니다.", e);
    }
}

function renderOrderStatus(room) {
    const status = document.getElementById("orderStatus");
    const button = document.getElementById("orderClosingBtn");
    const orderForm = document.getElementById("orderForm");
    const helperPanel = document.getElementById("menuHelperPanel");
    const importPanel = document.getElementById("menuImportPanel");
    if (!status || !button) return;

    status.innerText = room.isOrderClosed ? "주문 마감" : "주문 받는 중";
    status.className = room.isOrderClosed ? "closed" : "open";
    button.innerText = room.isOrderClosed ? "주문 다시 열기" : "주문 마감";
    button.className = room.isOrderClosed ? "reopen-btn" : "close-order-btn";

    [orderForm, helperPanel, importPanel].forEach(element => {
        if (!element) return;
        element.classList.toggle("order-closed", room.isOrderClosed);
        element.querySelectorAll("input, textarea, button").forEach(control => {
            control.disabled = room.isOrderClosed;
        });
    });
}

function normalizeDonation(value) {
    const donation = Number(value || 0);
    return Number.isInteger(donation) && donation >= 0 ? donation : NaN;
}

async function toggleOrderClosing() {
    if (!currentRoomData) return;

    const willClose = !currentRoomData.isOrderClosed;
    const password = prompt(willClose
        ? "주문을 마감하려면 관리 비밀번호 4자리를 입력해 주십시오."
        : "주문을 다시 열려면 관리 비밀번호 4자리를 입력해 주십시오.");
    if (password === null) return;
    if (!/^\d{4}$/.test(password)) {
        alert("관리 비밀번호는 숫자 4자리여야 합니다.");
        return;
    }

    try {
        const res = await fetch(`/api/rooms/${roomId}/order-closing`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isOrderClosed: willClose, password })
        });

        if (res.ok) {
            initRoom();
        } else {
            const message = await res.text();
            alert(message || "주문 상태 변경에 실패했습니다.");
        }
    } catch (error) {
        console.error(error);
        alert("네트워크 문제로 주문 상태를 변경하지 못했습니다.");
    }
}

function toggleCart() {
    isCartCollapsed = !isCartCollapsed;
    const content = document.getElementById("cartContent");
    const icon = document.getElementById("cartToggleIcon");
    const toggle = document.querySelector(".cart-toggle");
    if (!content || !icon || !toggle) return;

    content.hidden = isCartCollapsed;
    icon.innerText = isCartCollapsed ? "⌄" : "⌃";
    toggle.setAttribute("aria-expanded", String(!isCartCollapsed));
}

// ================= 요기요 링크 메타 미리보기 =================
async function loadYogiyoPreview(link) {
    const preview = document.getElementById("yogiyoPreview");
    if (!preview || !link || link === previewedYogiyoLink) return;

    previewedYogiyoLink = link;
    preview.hidden = false;
    preview.innerHTML = '<p class="preview-loading">요기요 매장 정보를 불러오는 중입니다…</p>';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
        const res = await fetch(`/api/rooms/${roomId}/yogiyo-preview`, { signal: controller.signal });
        if (!res.ok) {
            const message = await res.text();
            renderYogiyoPreviewError(preview, message || "요기요 매장 정보를 불러오지 못했습니다.");
            return;
        }

        const info = await res.json();
        const imageHtml = info.image
            ? `<img src="${escapeHtml(info.image)}" alt="요기요 매장 이미지" referrerpolicy="no-referrer" />`
            : '<div class="preview-placeholder">🛵</div>';
        const descriptionHtml = info.description
            ? `<p>${escapeHtml(info.description)}</p>`
            : '';

        preview.innerHTML = `
            ${imageHtml}
            <div class="preview-content">
                <span>요기요 주문 매장</span>
                <strong>${escapeHtml(info.title)}</strong>
                ${descriptionHtml}
            </div>
        `;
    } catch (e) {
        console.warn("요기요 미리보기를 불러오지 못했습니다.", e);
        const message = e.name === "AbortError"
            ? "요기요 매장 정보 응답 시간이 초과되었습니다."
            : "요기요 매장 정보를 불러오지 못했습니다.";
        renderYogiyoPreviewError(preview, message);
    } finally {
        clearTimeout(timeoutId);
    }
}

function renderYogiyoPreviewError(preview, message) {
    preview.innerHTML = `
        <div class="preview-placeholder">⚠️</div>
        <div class="preview-content preview-error">
            <span>${escapeHtml(message)}</span>
            <button type="button" onclick="retryYogiyoPreview()">다시 시도</button>
        </div>
    `;
}

function retryYogiyoPreview() {
    if (!currentRoomData?.link) return;
    previewedYogiyoLink = null;
    loadYogiyoPreview(currentRoomData.link);
}

// ================= 복사한 메뉴 텍스트 보조 입력 =================
function applyPastedMenu() {
    const pastedMenu = document.getElementById("menuPaste");
    const menuInput = document.getElementById("menu");
    const amountInput = document.getElementById("amount");
    const text = pastedMenu.value.trim();

    if (!text) {
        alert("요기요에서 복사한 메뉴와 가격을 붙여넣어 주십시오.");
        return;
    }

    const match = text.match(/^(?<menu>.*?)(?:\s*[-:·|]?\s*)(?<amount>[\d,]+)\s*원?\s*$/);
    if (!match?.groups?.menu || !match.groups.amount) {
        alert("예: 치즈돈까스 12,000원 형식으로 입력해 주십시오.");
        return;
    }

    const amount = Number(match.groups.amount.replaceAll(",", ""));
    if (!Number.isInteger(amount) || amount <= 0) {
        alert("올바른 메뉴 가격을 찾지 못했습니다.");
        return;
    }

    menuInput.value = match.groups.menu.trim();
    amountInput.value = amount;
    pastedMenu.value = "";
    menuInput.focus();
}

// ================= 요기요 공개 메뉴 후보 불러오기 =================
async function loadYogiyoMenuCandidates() {
    const candidateList = document.getElementById("yogiyoMenuCandidates");
    const importButton = document.getElementById("menuImportBtn");
    if (!candidateList || !importButton) return;

    importButton.disabled = true;
    importButton.innerText = "메뉴 확인 중…";
    candidateList.innerHTML = '<p class="empty-panel">공개 메뉴 정보를 확인하는 중입니다…</p>';

    try {
        const res = await fetch(`/api/rooms/${roomId}/yogiyo-menu-candidates`);
        if (!res.ok) {
            const message = await res.text();
            candidateList.innerHTML = `<p class="empty-panel">${escapeHtml(message || "메뉴 후보를 불러오지 못했습니다.")}</p>`;
            return;
        }

        const { items } = await res.json();
        if (!items?.length) {
            candidateList.innerHTML = '<p class="empty-panel">이 요기요 공유 링크는 현재 공개 페이지에 메뉴·가격을 제공하지 않습니다. 요기요에서 메뉴를 복사해 붙여넣기 기능을 이용해 주세요.</p>';
            return;
        }

        candidateList.innerHTML = items.map((item, index) => `
            <button class="menu-candidate" type="button" onclick="selectYogiyoMenuCandidate(${index})">
                <span>${escapeHtml(item.name)}</span>
                <b>${Number(item.price).toLocaleString()}원</b>
            </button>
        `).join("");
        candidateList.dataset.items = JSON.stringify(items);
    } catch (e) {
        console.warn("요기요 메뉴 후보를 불러오지 못했습니다.", e);
        candidateList.innerHTML = '<p class="empty-panel">메뉴 후보 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.</p>';
    } finally {
        importButton.disabled = false;
        importButton.innerText = "메뉴 후보 불러오기";
    }
}

function selectYogiyoMenuCandidate(index) {
    const candidateList = document.getElementById("yogiyoMenuCandidates");
    const items = JSON.parse(candidateList.dataset.items || "[]");
    const item = items[index];
    if (!item) return;

    document.getElementById("menu").value = item.name;
    document.getElementById("amount").value = item.price;
    document.getElementById("menu").focus();
}

// ================= 방 삭제 권한 가시성 체크 =================
function checkDeleteButtonPermission(room) {
    const deleteBtn = document.getElementById("deleteBtn");
    if (!deleteBtn) return;

    deleteBtn.style.display = "block";
}

// ================= 요기요 배달비 · 쿠폰 저장 =================
async function saveSettlement() {
    const deliveryFee = Number(document.getElementById("deliveryFee").value || 0);
    const couponDiscount = Number(document.getElementById("couponDiscount").value || 0);

    if (!Number.isInteger(deliveryFee) || !Number.isInteger(couponDiscount) || deliveryFee < 0 || couponDiscount < 0) {
        alert("배달비와 쿠폰 할인은 0원 이상의 정수로 입력해 주십시오.");
        return;
    }

    const password = prompt("배달비·쿠폰을 저장하려면 관리 비밀번호 4자리를 입력해 주십시오.");
    if (password === null) return;
    if (!/^\d{4}$/.test(password)) {
        alert("관리 비밀번호는 숫자 4자리여야 합니다.");
        return;
    }

    try {
        const res = await fetch(`/api/rooms/${roomId}/settlement`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deliveryFee, couponDiscount, password })
        });

        if (res.ok) {
            initRoom();
        } else {
            const errMsg = await res.text();
            alert(errMsg || "정산 설정 저장에 실패했습니다.");
        }
    } catch (e) {
        console.error(e);
        alert("네트워크 장애로 정산 설정을 저장하지 못했습니다.");
    }
}

// ================= 주문 신청 추가 =================
async function addOrder() {
    const nameEl = document.getElementById("name");
    const menuEl = document.getElementById("menu");
    const amountEl = document.getElementById("amount");
    const donationEl = document.getElementById("donation");

    const name = nameEl.value.trim();
    const menu = menuEl.value.trim();
    const amount = parseInt(amountEl.value);
    const donation = normalizeDonation(donationEl?.value);

    if (!name || !menu || isNaN(amount) || amount <= 0 || isNaN(donation)) {
        alert("이름, 메뉴, 올바른 금액과 기부 금액을 확인해 주십시오.");
        return;
    }

    if (!isValidName(name)) {
        alert("이름에는 문자(한글, 영문)만 입력할 수 있습니다. (숫자/특수문자 제한)");
        return;
    }

    // 이름은 로컬 스토리지에 보존
    localStorage.setItem("name", name);

    try {
        const res = await fetch(`/api/rooms/${roomId}/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Order-Owner": orderOwnerToken },
            body: JSON.stringify({ name, menu, amount, donation })
        });

        if (res.ok) {
            const responseText = await res.text();
            if (responseText) {
                const createdOrder = JSON.parse(responseText);
                if (createdOrder.id) {
                    rememberOwnedOrder(createdOrder.id);
                }
            }
            // UX 편의를 위해 이름(Name)은 지우지 않고 메뉴(Menu), 금액(Amount), 기부(Donation)만 비워줍니다.
            menuEl.value = "";
            amountEl.value = "";
            if (donationEl) donationEl.value = "0";
            initRoom();
        } else {
            const errMsg = await res.text();
            alert(errMsg || "주문 등록에 실패했습니다.");
        }
    } catch (e) {
        console.error(e);
        alert("네트워크 통신 불안정으로 등록하지 못했습니다.");
    }
}

// ================= 입금 완료 토글 처리 =================
async function toggle(id) {
    // 인라인 수정 중인 상태라면 토글이 격리되도록 방어합니다.
    if (editingParticipantId === id) return;

    try {
        const res = await fetch(`/api/rooms/${roomId}/toggle/${id}`, {
            method: "POST",
            headers: { "X-Order-Owner": orderOwnerToken }
        });
        if (res.ok) {
            initRoom();
        } else {
            const errMsg = await res.text();
            alert(errMsg || "입금 상태를 변경할 수 없습니다.");
        }
    } catch (e) {
        console.error(e);
    }
}

// ================= 개별 주문 수정 저장 (API 전송) =================
async function saveEditOrder(pid) {
    const editName = document.getElementById(`edit-name-${pid}`).value.trim();
    const editMenu = document.getElementById(`edit-menu-${pid}`).value.trim();
    const editAmount = parseInt(document.getElementById(`edit-amount-${pid}`).value);
    const editDonation = normalizeDonation(document.getElementById(`edit-donation-${pid}`)?.value);

    if (!editName || !editMenu || isNaN(editAmount) || editAmount <= 0 || isNaN(editDonation)) {
        alert("이름, 메뉴, 올바른 금액과 기부 금액을 입력해 주십시오.");
        return;
    }

    if (!isValidName(editName)) {
        alert("이름에는 문자(한글, 영문)만 입력할 수 있습니다.");
        return;
    }

    try {
        const res = await fetch(`/api/rooms/${roomId}/participants/${pid}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-Order-Owner": orderOwnerToken },
            body: JSON.stringify({ name: editName, menu: editMenu, amount: editAmount, donation: editDonation })
        });

        if (res.ok) {
            editingParticipantId = null;
            initRoom();
        } else {
            const errMsg = await res.text();
            alert(errMsg || "주문 정보 수정에 실패했습니다.");
        }
    } catch (e) {
        console.error(e);
        alert("네트워크 통신 불안정으로 수정할 수 없습니다.");
    }
}

// ================= 개별 주문 삭제 =================
async function deleteOrder(pid) {
    if (!confirm("이 주문 내역을 목록에서 완전히 삭제하시겠습니까?")) return;

    try {
        const res = await fetch(`/api/rooms/${roomId}/participants/${pid}`, {
            method: "DELETE",
            headers: { "X-Order-Owner": orderOwnerToken }
        });

        if (res.ok) {
            initRoom();
        } else {
            alert("주문 삭제에 실패했습니다.");
        }
    } catch (e) {
        console.error(e);
        alert("네트워크 상태를 확인해 주십시오.");
    }
}

// ================= 방 전체 삭제 =================
async function deleteRoom() {
    if (!confirm("정말 이 콩스밥밥 방(기차)을 폐쇄하고 삭제하시겠습니까?")) {
        return;
    }

    const password = prompt("방을 삭제하려면 설정한 숫자 4자리 비밀번호를 입력해 주십시오.");
    if (password === null) return;

    if (!/^\d{4}$/.test(password)) {
        alert("삭제 비밀번호는 숫자 4자리로 입력해 주십시오.");
        return;
    }

    try {
        const res = await fetch(`/api/rooms/${roomId}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password })
        });

        if (res.ok) {
            alert("방이 성공적으로 삭제되었습니다.");
            location.href = "/";
        } else {
            const errMsg = await res.text();
            alert(errMsg || "방 삭제에 실패했습니다.");
        }
    } catch (e) {
        console.error(e);
        alert("네트워크 장애로 방을 폐쇄하는데 실패했습니다.");
    }
}

// ================= 방 멤버 렌더링 및 결산 연산 =================
function render(room) {
    const list = document.getElementById("list");
    if (!list) return;
    list.innerHTML = "";

    const deliveryFee = Math.max(0, Number(room.deliveryFee) || 0);
    const couponDiscount = Math.max(0, Number(room.couponDiscount) || 0);
    const participants = [...room.participants].sort((a, b) => a.paid - b.paid);
    const totalAmount = participants.reduce((sum, participant) => sum + participant.amount, 0);
    const donationTotal = participants.reduce((sum, participant) => sum + Math.max(0, Number(participant.donation) || 0), 0);
    const appliedCoupon = Math.min(couponDiscount, totalAmount);
    const finalTotal = totalAmount - appliedCoupon + deliveryFee;
    const remainingPoints = totalAmount + donationTotal - finalTotal;
    let unpaidAmount = 0;

    // 미입금 유저를 리스트 위쪽에 정렬
    participants.forEach(p => {
        const donation = Math.max(0, Number(p.donation) || 0);
        if (!p.paid) {
            unpaidAmount += p.amount + donation;
        }

        const div = document.createElement("div");

        // 1. 현재 이 항목이 수정 중인 모드인 경우
        if (editingParticipantId === p.id) {
            div.className = "item edit-mode-card";
            div.innerHTML = `
                <div class="edit-fields-row">
                    <input id="edit-name-${p.id}" class="edit-input" value="${escapeHtml(p.name)}" placeholder="이름" />
                    <input id="edit-menu-${p.id}" class="edit-input" value="${escapeHtml(p.menu)}" placeholder="메뉴" />
                    <input id="edit-amount-${p.id}" class="edit-input" type="number" value="${p.amount}" placeholder="금액" />
                    <input id="edit-donation-${p.id}" class="edit-input" type="number" min="0" value="${donation}" placeholder="기부" />
                </div>
                <div class="edit-actions-row">
                    <button class="save-edit-btn" onclick="event.stopPropagation(); saveEditOrder('${p.id}');">💾 저장</button>
                    <button class="cancel-edit-btn" onclick="event.stopPropagation(); editingParticipantId = null; render(currentRoomData);">❌ 취소</button>
                </div>
            `;
        } 
        // 2. 일반 보기 모드인 경우
        else {
            div.className = p.paid ? "item paid" : "item";

            const isOwner = p.canManage || getOwnedOrderIds().has(p.id);
            if (isOwner) {
                div.onclick = () => toggle(p.id);
                div.title = "클릭하여 입금 상태 변경";
            }
            const actionButtons = isOwner ? `
                <div class="action-buttons-wrap">
                    <button class="action-edit-btn" title="수정" onclick="event.stopPropagation(); editingParticipantId = '${p.id}'; render(currentRoomData);">✏️</button>
                    <button class="action-del-btn" title="삭제" onclick="event.stopPropagation(); deleteOrder('${p.id}');">🗑️</button>
                </div>
            ` : "";

            div.innerHTML = `
                <div class="row">
                    <span class="text"><strong>${escapeHtml(p.name)}</strong> - ${escapeHtml(p.menu)}</span>
                </div>
                <div class="amount-area-actions">
                    <div class="amount-area">
                        <span class="price">${p.amount.toLocaleString()}원</span>
                        ${donation > 0 ? `<span class="donation">기부 ${donation.toLocaleString()}원</span>` : ""}
                        <span class="badge ${p.paid ? "paid" : ""}">${p.paid ? "입금완료" : "미입금"}</span>
                    </div>
                    ${actionButtons}
                </div>
            `;
        }

        list.appendChild(div);
    });

    renderCart(participants);
    renderShares(participants, totalAmount, finalTotal);

    const deliveryFeeInput = document.getElementById("deliveryFee");
    const couponDiscountInput = document.getElementById("couponDiscount");
    if (deliveryFeeInput && document.activeElement !== deliveryFeeInput) deliveryFeeInput.value = deliveryFee;
    if (couponDiscountInput && document.activeElement !== couponDiscountInput) couponDiscountInput.value = couponDiscount;

    // 화면 정산 필드 즉시 갱신
    document.getElementById("total").innerText = `${totalAmount.toLocaleString()}원`;
    document.getElementById("coupon").innerText = `-${appliedCoupon.toLocaleString()}원`;
    document.getElementById("delivery").innerText = `+${deliveryFee.toLocaleString()}원`;
    document.getElementById("donationTotal").innerText = `${donationTotal.toLocaleString()}원`;
    document.getElementById("finalTotal").innerText = `${finalTotal.toLocaleString()}원`;
    document.getElementById("unpaid").innerText = `${unpaidAmount.toLocaleString()}원`;
    document.getElementById("remainingPoints").innerText = `${remainingPoints.toLocaleString()}원`;
}

function renderCart(participants) {
    const cartList = document.getElementById("cartList");
    const cartCount = document.getElementById("cartCount");
    if (!cartList || !cartCount) return;

    const groupedItems = new Map();
    participants.forEach(participant => {
        const key = `${participant.menu}\u0000${participant.amount}`;
        const item = groupedItems.get(key) || { menu: participant.menu, amount: participant.amount, quantity: 0 };
        item.quantity += 1;
        groupedItems.set(key, item);
    });

    const items = [...groupedItems.values()].sort((left, right) => right.quantity - left.quantity || left.menu.localeCompare(right.menu));
    cartCount.innerText = `${items.length}개 메뉴 · ${participants.length}개 주문`;

    if (items.length === 0) {
        cartList.innerHTML = '<p class="empty-panel">아직 담긴 메뉴가 없습니다.</p>';
        return;
    }

    cartList.innerHTML = items.map(item => `
        <div class="cart-item">
            <span>${escapeHtml(item.menu)}</span>
            <strong>${item.quantity}개 · ${(item.amount * item.quantity).toLocaleString()}원</strong>
        </div>
    `).join("");
}

function renderShares(participants, totalAmount, finalTotal) {
    const shareList = document.getElementById("shareList");
    if (!shareList) return;

    if (participants.length === 0) {
        shareList.innerHTML = '<p class="empty-panel">주문을 추가하면 개인별 부담금이 계산됩니다.</p>';
        return;
    }

    let assignedAmount = 0;
    shareList.innerHTML = participants.map((participant, index) => {
        const donation = Math.max(0, Number(participant.donation) || 0);
        const isLast = index === participants.length - 1;
        const baseShare = totalAmount === 0
            ? 0
            : isLast
                ? finalTotal - assignedAmount
                : Math.round((participant.amount / totalAmount) * finalTotal);
        assignedAmount += baseShare;
        const share = baseShare + donation;

        return `
            <div class="share-item">
                <span><strong>${escapeHtml(participant.name)}</strong><small>${escapeHtml(participant.menu)} · 주문 ${participant.amount.toLocaleString()}원${donation > 0 ? ` · 기부 ${donation.toLocaleString()}원 포함` : ""}</small></span>
                <div class="share-amount"><b>${share.toLocaleString()}원</b></div>
            </div>
        `;
    }).join("");
}

// ================= 뒤로가기 =================
function goHome() {
    location.href = "/";
}

// ================= HTML 이스케이프 헬퍼 =================
function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
}
