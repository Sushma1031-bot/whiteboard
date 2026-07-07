const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let whiteboardState = {
  strokes: []
};

function sanitizeStroke(stroke) {
  if (!stroke || typeof stroke !== 'object') return null;
  if (!Array.isArray(stroke.points) || stroke.points.length === 0) return null;

  return {
    id: String(stroke.id || ''),
    tool: stroke.tool === 'eraser' ? 'eraser' : 'pen',
    color: typeof stroke.color === 'string' ? stroke.color : '#000000',
    size: Number.isFinite(Number(stroke.size)) ? Number(stroke.size) : 5,
    points: stroke.points
      .filter(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
      .map(p => ({
        x: Number(p.x),
        y: Number(p.y)
      })),
    by: stroke.by || null,
    ts: Number.isFinite(Number(stroke.ts)) ? Number(stroke.ts) : Date.now()
  };
}

function broadcastUserCount() {
  const count = io.of('/').sockets.size;
  io.emit('users:count', count);
}

function getStatePayload() {
  return {
    strokes: whiteboardState.strokes,
    users: io.of('/').sockets.size
  };
}

io.on('connection', socket => {
  socket.emit('whiteboard:state', getStatePayload());
  broadcastUserCount();

  socket.on('whiteboard:requestState', () => {
    socket.emit('whiteboard:state', getStatePayload());
  });

  socket.on('stroke:start', data => {
    const payload = {
      id: String(data?.id || ''),
      tool: data?.tool === 'eraser' ? 'eraser' : 'pen',
      color: typeof data?.color === 'string' ? data.color : '#000000',
      size: Number.isFinite(Number(data?.size)) ? Number(data.size) : 5,
      points: [],
      by: socket.id,
      ts: Number.isFinite(Number(data?.ts)) ? Number(data.ts) : Date.now()
    };

    socket.broadcast.emit('stroke:start', payload);
  });

  socket.on('stroke:point', data => {
    if (!data || !data.id || !data.point) return;

    const payload = {
      id: String(data.id),
      point: {
        x: Number(data.point.x),
        y: Number(data.point.y)
      },
      by: socket.id
    };

    socket.broadcast.emit('stroke:point', payload);
  });

  socket.on('stroke:end', data => {
    const stroke = sanitizeStroke(data);
    if (!stroke) return;

    stroke.by = socket.id;
    whiteboardState.strokes.push(stroke);

    socket.broadcast.emit('stroke:end', stroke);
  });

  socket.on('stroke:batch', batch => {
    if (!Array.isArray(batch)) return;
    for (const item of batch) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'stroke:start') {
        socket.broadcast.emit('stroke:start', {
          ...(item.data || item),
          by: socket.id
        });
      } else if (item.type === 'stroke:point') {
        socket.broadcast.emit('stroke:point', {
          ...(item.data || item),
          by: socket.id
        });
      } else if (item.type === 'stroke:end') {
        const stroke = sanitizeStroke(item.data || item);
        if (!stroke) continue;
        stroke.by = socket.id;
        whiteboardState.strokes.push(stroke);
        socket.broadcast.emit('stroke:end', stroke);
      }
    }
  });

  socket.on('whiteboard:clear', () => {
    whiteboardState.strokes = [];
    io.emit('whiteboard:clear');
  });

  socket.on('whiteboard:undo', () => {
    if (whiteboardState.strokes.length > 0) {
      whiteboardState.strokes.pop();
      io.emit('whiteboard:undo');
    }
  });

  socket.on('disconnect', () => {
    broadcastUserCount();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});