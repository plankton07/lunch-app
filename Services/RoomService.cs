public class RoomService
{
    private readonly List<Room> _rooms = new();

    public List<Room> GetAll() => _rooms;

    public Room Get(string id) => _rooms.FirstOrDefault(r => r.Id == id);

    public Room Create(string title)
    {
        var room = new Room { Title = title };
        _rooms.Add(room);
        return room;
    }

    public void Delete(string id)
    {
        var room = Get(id);
        if (room != null)
            _rooms.Remove(room);
    }
}
