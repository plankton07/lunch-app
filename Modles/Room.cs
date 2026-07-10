using System.Text.Json.Serialization;

public class Room
{
    public string Id { get; set; } = Guid.NewGuid().ToString();

    public string Title { get; set; }

    // ✅ 추가
    public string Host { get; set; }

    // ✅ 추가
    public string Link { get; set; }

    [JsonIgnore]
    public string DeletePassword { get; set; } = string.Empty;

    public List<Participant> Participants { get; set; } = new();
}

public class CreateRoomRequest
{
    public string Title { get; set; } = string.Empty;
    public string Host { get; set; } = string.Empty;
    public string Link { get; set; } = string.Empty;
    public string Password { get; set; } = string.Empty;
}

public class DeleteRoomRequest
{
    public string Password { get; set; } = string.Empty;
}

public class Participant
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; }
    public string Menu { get; set; }
    public int Amount { get; set; }
    public bool Paid { get; set; }
}
