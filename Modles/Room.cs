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

    public int DeliveryFee { get; set; }
    public int CouponDiscount { get; set; }
    public bool IsOrderClosed { get; set; }

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

public class SettlementRequest
{
    public int DeliveryFee { get; set; }
    public int CouponDiscount { get; set; }
    public string Password { get; set; } = string.Empty;
}

public class OrderClosingRequest
{
    public bool IsOrderClosed { get; set; }
    public string Password { get; set; } = string.Empty;
}

public class Participant
{
    public string Id { get; set; } = Guid.NewGuid().ToString();

    [JsonIgnore]
    public string OwnerToken { get; set; } = string.Empty;

    public string Name { get; set; }
    public string Menu { get; set; }
    public int Amount { get; set; }
    public int Donation { get; set; }
    public bool Paid { get; set; }
}
