(() => {
  'use strict';

  const socket = window.socket || (typeof io === 'function' ? io() : null);
  const canvas = document.getElementById('canvas');
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;

  const colorPicker = document.getElementById('colorPicker');
  const brushSize = document.getElementById('brushSize');
  const penBtn = document.getElementById('penBtn');
  const eraserBtn = document.getElementById('eraserBtn');
  const undoBtn = document.getElementById('undoBtn');
  const clearBtn = document.getElementById('clearBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const userCount = document.getElementById('userCount');

  if (!canvas || !ctx) return;

  const state = {
    tool: 'pen',
    color: colorPicker?.value || '#2563eb',
    size: Number(brushSize?.value || 5),
    drawing: false,
    currentStrokeId: null,
    lastPoint: null,
    strokes: [],
    redoStack: [],
    activePointers: new Set(),
    dpr: Math.max(window.devicePixelRatio || 1, 1),
    cssWidth: 0,
    cssHeight: 0,
    initialized: false,
    connected: false,
    reconnecting: false,
    userCount: 1,
    emitQueue: [],
    emitScheduled: false,
    remoteStrokes: new Map(),
    localStrokeSeq: 0,
    rafRedrawScheduled: false,
    _currentStroke: null,
  };

  const CANVAS_BG = '#ffffff';
  const MAX_HISTORY = 300;
  const EMIT_DELAY = 16;
  const MAX_BATCH = 12;

  const hasPointerEvents = 'PointerEvent' in window;
  const strokeCap = 'round';
  const strokeJoin = 'round';

  function uid() {
    state.localStrokeSeq += 1;
    return `stroke_${Date.now()}_${state.localStrokeSeq}_${Math.random().toString(16).slice(2)}`;
  }

  function setStatus(text) {
    if (!userCount) return;
    userCount.textContent = `Users: ${state.userCount} • ${text}`;
  }

  function updateUserCount(count) {
    state.userCount = Number.isFinite(+count) ? +count : state.userCount;
    const status = state.connected ? 'Connected' : state.reconnecting ? 'Reconnecting' : 'Disconnected';
    setStatus(status);
  }

  function setActiveTool(tool) {
    state.tool = tool;
    penBtn?.classList.toggle('active', tool === 'pen');
    eraserBtn?.classList.toggle('active', tool === 'eraser');
  }

  function getRect() {
    return canvas.getBoundingClientRect();
  }

  function toCanvasPoint(clientX, clientY) {
    const rect = getRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function setupContext() {
    ctx.lineCap = strokeCap;
    ctx.lineJoin = strokeJoin;
    ctx.imageSmoothingEnabled = true;
  }

  function fillWhiteBackground(context) {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = CANVAS_BG;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
  }

  function resizeCanvas(preserve = true) {
    const rect = getRect();
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    const nextDpr = Math.max(window.devicePixelRatio || 1, 1);

    if (
      cssWidth === state.cssWidth &&
      cssHeight === state.cssHeight &&
      nextDpr === state.dpr
    ) return;

    let snapshot = null;
    if (preserve && canvas.width && canvas.height) {
      snapshot = document.createElement('canvas');
      snapshot.width = canvas.width;
      snapshot.height = canvas.height;
      snapshot.getContext('2d').drawImage(canvas, 0, 0);
    }

    state.cssWidth = cssWidth;
    state.cssHeight = cssHeight;
    state.dpr = nextDpr;

    canvas.width = Math.floor(cssWidth * nextDpr);
    canvas.height = Math.floor(cssHeight * nextDpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    setupContext();
    ctx.setTransform(nextDpr, 0, 0, nextDpr, 0, 0);
    fillWhiteBackground(ctx);

    if (snapshot) {
      ctx.save();
      ctx.setTransform(nextDpr, 0, 0, nextDpr, 0, 0);
      ctx.drawImage(
        snapshot,
        0,
        0,
        snapshot.width / state.dpr,
        snapshot.height / state.dpr,
        0,
        0,
        cssWidth,
        cssHeight
      );
      ctx.restore();
      ctx.setTransform(nextDpr, 0, 0, nextDpr, 0, 0);
    }
  }

  function setBrushStyle(context, stroke) {
    context.lineCap = strokeCap;
    context.lineJoin = strokeJoin;
    context.lineWidth = stroke.size;
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  }

  function drawPoint(context, stroke, point) {
    context.save();
    setBrushStyle(context, stroke);
    context.beginPath();
    context.arc(point.x, point.y, Math.max(0.5, stroke.size / 2), 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  function drawSegment(context, stroke, from, to) {
    context.save();
    setBrushStyle(context, stroke);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.restore();
  }

  function drawStroke(context, stroke) {
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) return;

    if (stroke.points.length === 1) {
      drawPoint(context, stroke, stroke.points[0]);
      return;
    }

    context.save();
    setBrushStyle(context, stroke);
    context.beginPath();
    context.moveTo(stroke.points[0].x, stroke.points[0].y);

    for (let i = 1; i < stroke.points.length; i += 1) {
      const prev = stroke.points[i - 1];
      const curr = stroke.points[i];
      const midX = (prev.x + curr.x) / 2;
      const midY = (prev.y + curr.y) / 2;
      context.quadraticCurveTo(prev.x, prev.y, midX, midY);
    }

    const last = stroke.points[stroke.points.length - 1];
    context.lineTo(last.x, last.y);
    context.stroke();
    context.restore();
  }

  function redrawAll() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    fillWhiteBackground(ctx);
    for (const stroke of state.strokes) drawStroke(ctx, stroke);
  }

  function scheduleRedraw() {
    if (state.rafRedrawScheduled) return;
    state.rafRedrawScheduled = true;
    requestAnimationFrame(() => {
      state.rafRedrawScheduled = false;
      redrawAll();
    });
  }

  function pushStroke(stroke) {
    if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length) return;
    state.strokes.push(stroke);
    if (state.strokes.length > MAX_HISTORY) {
      state.strokes.splice(0, state.strokes.length - MAX_HISTORY);
    }
    state.redoStack.length = 0;
  }

  function enqueueEmit(payload) {
    if (!socket?.connected) return;
    state.emitQueue.push(payload);
    if (state.emitScheduled) return;

    state.emitScheduled = true;
    setTimeout(() => {
      state.emitScheduled = false;
      if (!socket?.connected) {
        state.emitQueue.length = 0;
        return;
      }

      while (state.emitQueue.length) {
        const batch = state.emitQueue.splice(0, MAX_BATCH);
        socket.emit('stroke:batch', batch);
      }
    }, EMIT_DELAY);
  }

  function startLocalStroke(point) {
    state.drawing = true;
    state.lastPoint = point;

    const stroke = {
      id: uid(),
      tool: state.tool,
      color: state.color,
      size: state.size,
      points: [point],
      by: socket?.id || null,
      ts: Date.now()
    };

    state.currentStrokeId = stroke.id;
    state._currentStroke = stroke;

    if (socket?.connected) {
      socket.emit('stroke:start', {
        id: stroke.id,
        tool: stroke.tool,
        color: stroke.color,
        size: stroke.size,
        ts: stroke.ts
      });
    }

    return stroke;
  }

  function appendLocalPoint(point) {
    if (!state._currentStroke) return;

    const stroke = state._currentStroke;
    const last = stroke.points[stroke.points.length - 1];
    const dx = point.x - last.x;
    const dy = point.y - last.y;

    if (Math.hypot(dx, dy) < 0.5) return;

    stroke.points.push(point);
    drawSegment(ctx, stroke, last, point);
    enqueueEmit({ type: 'stroke:point', id: stroke.id, point });
  }

  function finishLocalStroke() {
    if (!state._currentStroke) return;

    const stroke = state._currentStroke;
    if (stroke.points.length === 1) {
      drawPoint(ctx, stroke, stroke.points[0]);
    }

    pushStroke(stroke);

    if (socket?.connected) {
      socket.emit('stroke:end', {
        id: stroke.id,
        points: stroke.points,
        tool: stroke.tool,
        color: stroke.color,
        size: stroke.size,
        by: stroke.by,
        ts: stroke.ts
      });
    }

    state._currentStroke = null;
    state.currentStrokeId = null;
    state.lastPoint = null;
    state.drawing = false;
  }

  function cancelLocalStroke() {
    state._currentStroke = null;
    state.currentStrokeId = null;
    state.lastPoint = null;
    state.drawing = false;
  }

  function remoteStrokeStart(data) {
    if (!data?.id) return;
    state.remoteStrokes.set(data.id, {
      id: data.id,
      tool: data.tool === 'eraser' ? 'eraser' : 'pen',
      color: data.color || '#000000',
      size: Number(data.size || 5),
      points: [],
      by: data.by || null,
      ts: data.ts || Date.now()
    });
  }

  function remoteStrokePoint(data) {
    const stroke = state.remoteStrokes.get(data?.id);
    if (!stroke || !data.point) return;

    const p = { x: data.point.x, y: data.point.y };
    const last = stroke.points[stroke.points.length - 1];
    stroke.points.push(p);

    if (last) drawSegment(ctx, stroke, last, p);
    else drawPoint(ctx, stroke, p);
  }

  function remoteStrokeEnd(data) {
    const stroke = state.remoteStrokes.get(data?.id);
    if (!stroke) return;

    if (Array.isArray(data.points) && data.points.length) {
      stroke.points = data.points.map(p => ({ x: p.x, y: p.y }));
    }

    state.remoteStrokes.delete(data.id);
    pushStroke(stroke);
  }

  function undoLocal() {
    if (!state.strokes.length) return;
    state.redoStack.push(state.strokes.pop());
    redrawAll();
    socket?.connected && socket.emit('whiteboard:undo', { by: socket.id || null });
  }

  function clearLocal(announce = true) {
    state.strokes.length = 0;
    state.redoStack.length = 0;
    state.remoteStrokes.clear();
    redrawAll();
    if (announce && socket?.connected) {
      socket.emit('whiteboard:clear', { by: socket.id || null });
    }
  }

  function downloadPNG() {
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;

    const ectx = exportCanvas.getContext('2d');
    ectx.fillStyle = CANVAS_BG;
    ectx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    ectx.drawImage(canvas, 0, 0);

    exportCanvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'whiteboard.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 500);
    }, 'image/png');
  }

  function pointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    state.activePointers.add(e.pointerId);

    const point = toCanvasPoint(e.clientX, e.clientY);
    const stroke = startLocalStroke(point);
    drawPoint(ctx, stroke, point);
  }

  function pointerMove(e) {
    if (!state.drawing || !state.activePointers.has(e.pointerId)) return;
    e.preventDefault();
    const point = toCanvasPoint(e.clientX, e.clientY);
    appendLocalPoint(point);
  }

  function pointerUp(e) {
    if (!state.activePointers.has(e.pointerId)) return;
    e.preventDefault();
    state.activePointers.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);
    finishLocalStroke();
  }

  function pointerCancel(e) {
    state.activePointers.delete(e.pointerId);
    canvas.releasePointerCapture?.(e.pointerId);
    cancelLocalStroke();
  }

  function mouseDown(e) {
    if (e.button !== 0) return;
    pointerDown({
      button: 0,
      pointerId: 1,
      clientX: e.clientX,
      clientY: e.clientY,
      preventDefault: () => e.preventDefault()
    });

    const move = ev => pointerMove({
      pointerId: 1,
      clientX: ev.clientX,
      clientY: ev.clientY,
      preventDefault: () => ev.preventDefault()
    });

    const up = ev => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      pointerUp({ pointerId: 1, preventDefault: () => ev.preventDefault() });
    };

    document.addEventListener('mousemove', move, { passive: false });
    document.addEventListener('mouseup', up, { passive: false });
  }

  function touchStart(e) {
    e.preventDefault();
    const t = e.changedTouches[0];
    pointerDown({
      button: 0,
      pointerId: t.identifier,
      clientX: t.clientX,
      clientY: t.clientY,
      preventDefault: () => e.preventDefault()
    });
  }

  function touchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      pointerMove({
        pointerId: t.identifier,
        clientX: t.clientX,
        clientY: t.clientY,
        preventDefault: () => e.preventDefault()
      });
    }
  }

  function touchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      pointerUp({
        pointerId: t.identifier,
        preventDefault: () => e.preventDefault()
      });
    }
  }

  function touchCancel(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      pointerCancel({
        pointerId: t.identifier,
        preventDefault: () => e.preventDefault()
      });
    }
  }

  function onKeyDown(e) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLocal();
      return;
    }

    const key = e.key.toLowerCase();
    if (key === 'p') setActiveTool('pen');
    else if (key === 'e') setActiveTool('eraser');
    else if (key === 'c') clearLocal(true);
    else if (key === 'd') downloadPNG();
  }

  function bindUI() {
    if (colorPicker) {
      colorPicker.value = state.color;
      colorPicker.addEventListener('input', e => {
        state.color = e.target.value;
      });
    }

    if (brushSize) {
      brushSize.value = String(state.size);
      brushSize.addEventListener('input', e => {
        state.size = Number(e.target.value || 5);
      });
    }

    penBtn?.addEventListener('click', () => setActiveTool('pen'));
    eraserBtn?.addEventListener('click', () => setActiveTool('eraser'));
    undoBtn?.addEventListener('click', undoLocal);
    clearBtn?.addEventListener('click', () => clearLocal(true));
    downloadBtn?.addEventListener('click', downloadPNG);
    penBtn?.classList.toggle('active', true);
    eraserBtn?.classList.toggle('active', false);
  }

  function bindCanvas() {
    canvas.style.touchAction = 'none';

    if (hasPointerEvents) {
      canvas.addEventListener('pointerdown', pointerDown, { passive: false });
      canvas.addEventListener('pointermove', pointerMove, { passive: false });
      canvas.addEventListener('pointerup', pointerUp, { passive: false });
      canvas.addEventListener('pointercancel', pointerCancel, { passive: false });
    } else {
      canvas.addEventListener('mousedown', mouseDown, { passive: false });
      canvas.addEventListener('touchstart', touchStart, { passive: false });
      canvas.addEventListener('touchmove', touchMove, { passive: false });
      canvas.addEventListener('touchend', touchEnd, { passive: false });
      canvas.addEventListener('touchcancel', touchCancel, { passive: false });
    }
  }

  function bindResize() {
    const ro = new ResizeObserver(() => resizeCanvas(true));
    ro.observe(canvas.parentElement || canvas);
    window.addEventListener('resize', () => resizeCanvas(true));
    window.addEventListener('orientationchange', () => setTimeout(() => resizeCanvas(true), 100));
  }

  function bindSocket() {
    if (!socket) {
      setStatus('Disconnected');
      return;
    }

    socket.on('connect', () => {
      state.connected = true;
      state.reconnecting = false;
      setStatus('Connected');
      socket.emit('whiteboard:requestState');
    });

    socket.on('disconnect', () => {
      state.connected = false;
      setStatus('Disconnected');
    });

    socket.on('reconnect_attempt', () => {
      state.reconnecting = true;
      setStatus('Reconnecting');
    });

    socket.on('reconnect', () => {
      state.connected = true;
      state.reconnecting = false;
      setStatus('Connected');
      socket.emit('whiteboard:requestState');
    });

    socket.on('users:count', count => updateUserCount(count));

    socket.on('whiteboard:state', payload => {
      const strokes = Array.isArray(payload?.strokes) ? payload.strokes : [];
      state.strokes.length = 0;
      state.redoStack.length = 0;

      for (const s of strokes) {
        if (!s || !Array.isArray(s.points)) continue;
        state.strokes.push({
          id: s.id || uid(),
          tool: s.tool === 'eraser' ? 'eraser' : 'pen',
          color: s.color || '#000000',
          size: Number(s.size || 5),
          points: s.points.map(p => ({ x: p.x, y: p.y })),
          by: s.by || null,
          ts: s.ts || Date.now()
        });
      }

      redrawAll();
      if (typeof payload?.users === 'number') updateUserCount(payload.users);
    });

    socket.on('stroke:start', data => {
      if (data?.by && data.by === socket.id) return;
      remoteStrokeStart(data);
    });

    socket.on('stroke:point', data => {
      if (data?.by && data.by === socket.id) return;
      remoteStrokePoint(data);
    });

    socket.on('stroke:end', data => {
      if (data?.by && data.by === socket.id) return;
      remoteStrokeEnd(data);
    });

    socket.on('stroke:batch', batch => {
      if (!Array.isArray(batch)) return;
      for (const item of batch) {
        if (item?.type === 'stroke:start') remoteStrokeStart(item);
        if (item?.type === 'stroke:point') remoteStrokePoint(item);
        if (item?.type === 'stroke:end') remoteStrokeEnd(item);
      }
    });

    socket.on('whiteboard:clear', () => {
      state.strokes.length = 0;
      state.redoStack.length = 0;
      state.remoteStrokes.clear();
      redrawAll();
    });

    socket.on('whiteboard:undo', () => {
      if (!state.strokes.length) return;
      state.strokes.pop();
      redrawAll();
    });
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    bindUI();
    bindCanvas();
    bindResize();
    bindSocket();

    window.addEventListener('keydown', onKeyDown);

    resizeCanvas(false);
    fillWhiteBackground(ctx);
    setStatus(socket?.connected ? 'Connected' : 'Connecting');

    if (!socket?.connected) updateUserCount(1);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();