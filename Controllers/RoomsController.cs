using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;

[ApiController]
[Route("api/[controller]")]
public class RoomsController : ControllerBase
{
    private readonly RoomService _service;
    private readonly IHubContext<UpdateHub> _hub;

    public RoomsController(RoomService service, IHubContext<UpdateHub> hub)
    {
        _service = service;
        _hub = hub;
    }

    // 이름 유효성 검사 (한글, 영문, 공백만 허용)
    private bool IsValidName(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return false;
        return Regex.IsMatch(name, @"^[a-zA-Z가-힣ㄱ-ㅎㅏ-ㅣ\s]+$");
    }

    // ================= 방 목록 =================
    [HttpGet]
    public IActionResult GetAll()
    {
        return Ok(_service.GetAll());
    }

    // ================= 방 조회 =================
    [HttpGet("{id}")]
    public IActionResult Get(string id)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();
        return Ok(room);
    }

    // ================= 방 생성 =================
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateRoomRequest req)
    {
        if (!IsValidName(req.Title))
        {
            return BadRequest("방 이름은 문자(한글, 영문)만 입력할 수 있습니다.");
        }
        if (!IsValidName(req.Host))
        {
            return BadRequest("방장 이름에는 문자(한글, 영문)만 입력할 수 있습니다.");
        }
        if (!Regex.IsMatch(req.Password ?? string.Empty, @"^\d{4}$"))
        {
            return BadRequest("삭제 비밀번호는 숫자 4자리여야 합니다.");
        }

        var room = new Room
        {
            Title = req.Title,
            Host = req.Host,
            Link = req.Link,
            DeletePassword = req.Password
        };

        _service.GetAll().Add(room);

        await _hub.Clients.All.SendAsync("Update");

        return Ok(room);
    }

    // ================= 참여 =================
    [HttpPost("{id}/join")]
    public async Task<IActionResult> Join(string id, [FromBody] Participant p)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        if (!IsValidName(p.Name))
        {
            return BadRequest("참여자 이름에는 문자(한글, 영문)만 입력할 수 있습니다.");
        }

        room.Participants.Add(p);

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }

    // ================= 참가자 개별 수정 =================
    [HttpPut("{id}/participants/{pid}")]
    public async Task<IActionResult> UpdateParticipant(string id, string pid, [FromBody] Participant updated)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        var p = room.Participants.FirstOrDefault(x => x.Id == pid);
        if (p == null) return NotFound();

        if (!IsValidName(updated.Name))
        {
            return BadRequest("이름에는 문자(한글, 영문)만 입력할 수 있습니다.");
        }

        p.Name = updated.Name;
        p.Menu = updated.Menu;
        p.Amount = updated.Amount;

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }

    // ================= 참가자 개별 삭제 =================
    [HttpDelete("{id}/participants/{pid}")]
    public async Task<IActionResult> DeleteParticipant(string id, string pid)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        var p = room.Participants.FirstOrDefault(x => x.Id == pid);
        if (p == null) return NotFound();

        room.Participants.Remove(p);

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }

    // ================= 체크 =================
    [HttpPost("{id}/toggle/{pid}")]
    public async Task<IActionResult> Toggle(string id, string pid)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        var p = room.Participants.FirstOrDefault(x => x.Id == pid);
        if (p == null) return NotFound();

        p.Paid = !p.Paid;

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }

    // ================= 삭제 =================
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, [FromBody] DeleteRoomRequest req)
    {
        var room = _service.Get(id);
        if (room == null) return NotFound();

        if (req == null || !Regex.IsMatch(req.Password ?? string.Empty, @"^\d{4}$"))
        {
            return BadRequest("삭제 비밀번호는 숫자 4자리여야 합니다.");
        }

        if (!string.Equals(room.DeletePassword, req.Password, StringComparison.Ordinal))
        {
            return StatusCode(403, "삭제 비밀번호가 일치하지 않습니다.");
        }

        _service.Delete(id);

        await _hub.Clients.All.SendAsync("Update");

        return Ok();
    }
}
