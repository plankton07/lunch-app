const roomId = new URLSearchParams(location.search).get("id");

// ================= 상태 관리 캐시 =================
let currentRoomData = null;
let editingParticipantId = null; // 현재 인라인 수정 중인 참여자 ID

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
    }
}

// ================= 대시보드 기차 목록 렌더링 =================
function renderRoomList(rooms) {
    const list = document.getElementById("roomList");
    if (!list) return;
    list.innerHTML = "";

    if (rooms.length === 0) {
        list.innerHTML = `<div class="empty-list-msg">🚂 아직 생성된 점심 기차가 없습니다. 첫 번째 기차를 생성해보세요!</div>`;
        return;
    }

    rooms.forEach(r => {
        const div = document.createElement("div");
        div.className = "room-card";

        // 카드 클릭 시에도 방 입장
        div.onclick = () => location.href = `room.html?id=${r.id}`;

        div.innerHTML = `
            <div class="room-info">
                <div class="title">${escapeHtml(r.title)}</div>
                <div class="meta">
                    <span>👤 방장: ${escapeHtml(r.host)}</span>
                    ${r.participants ? `<span>👥 인원: ${r.participants.length}명</span>` : ""}
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
        const res = await fetch(`/api/rooms/${roomId}`);
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

            // 참여 멤버 리스트 렌더링
            render(room);
        }
    } catch (e) {
        console.error("방 정보를 가져오지 못했습니다.", e);
    }
}

// ================= 방 삭제 권한 가시성 체크 =================
function checkDeleteButtonPermission(room) {
    const deleteBtn = document.getElementById("deleteBtn");
    if (!deleteBtn) return;

    deleteBtn.style.display = "block";
}

// ================= 주문 신청 추가 =================
async function addOrder() {
    const nameEl = document.getElementById("name");
    const menuEl = document.getElementById("menu");
    const amountEl = document.getElementById("amount");

    const name = nameEl.value.trim();
    const menu = menuEl.value.trim();
    const amount = parseInt(amountEl.value);

    if (!name || !menu || isNaN(amount) || amount <= 0) {
        alert("이름, 메뉴, 올바른 금액을 모두 입력해주셔야 합니다.");
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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, menu, amount })
        });

        if (res.ok) {
            // UX 편의를 위해 이름(Name)은 지우지 않고 메뉴(Menu)와 금액(Amount)만 비워줍니다.
            menuEl.value = "";
            amountEl.value = "";
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
            method: "POST"
        });
        if (res.ok) {
            initRoom();
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

    if (!editName || !editMenu || isNaN(editAmount) || editAmount <= 0) {
        alert("이름, 메뉴, 올바른 금액을 입력해 주십시오.");
        return;
    }

    if (!isValidName(editName)) {
        alert("이름에는 문자(한글, 영문)만 입력할 수 있습니다.");
        return;
    }

    try {
        const res = await fetch(`/api/rooms/${roomId}/participants/${pid}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: editName, menu: editMenu, amount: editAmount })
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
            method: "DELETE"
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

    let totalAmount = 0;
    let unpaidAmount = 0;

    // 미입금 유저를 리스트 위쪽에 정렬
    room.participants.sort((a, b) => a.paid - b.paid);

    room.participants.forEach(p => {
        totalAmount += p.amount;
        if (!p.paid) {
            unpaidAmount += p.amount;
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
            // 카드 클릭으로 입금 토글
            div.onclick = () => toggle(p.id);

            const colors = ["red", "blue", "green", "purple", "orange"];
            const charVal = p.name ? p.name.charCodeAt(0) : 0;
            const colorClass = colors[charVal % colors.length];
            const initialText = p.name ? p.name.trim().charAt(0) : "?";

            div.innerHTML = `
                <div class="row">
                    <span class="profile ${colorClass}">${escapeHtml(initialText)}</span>
                    <span class="text"><strong>${escapeHtml(p.name)}</strong> - ${escapeHtml(p.menu)}</span>
                </div>
                <div class="amount-area-actions">
                    <div class="amount-area">
                        <span class="price">${p.amount.toLocaleString()}원</span>
                        <span class="badge ${p.paid ? "paid" : ""}">${p.paid ? "입금완료" : "미입금"}</span>
                    </div>
                    <div class="action-buttons-wrap">
                        <button class="action-edit-btn" title="수정" onclick="event.stopPropagation(); editingParticipantId = '${p.id}'; render(currentRoomData);">✏️</button>
                        <button class="action-del-btn" title="삭제" onclick="event.stopPropagation(); deleteOrder('${p.id}');">🗑️</button>
                    </div>
                </div>
            `;
        }

        list.appendChild(div);
    });

    // 화면 정산 필드 즉시 갱신
    document.getElementById("total").innerText = totalAmount.toLocaleString();
    document.getElementById("unpaid").innerText = unpaidAmount.toLocaleString();
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
