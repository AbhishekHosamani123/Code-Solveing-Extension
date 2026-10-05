"""Generate extension icons (16/32/48/128): indigo rounded square + white lightning bolt."""
import struct
import zlib

def make_png(size):
    # Rounded-corner mask
    radius = size * 0.18

    def in_bg(x, y):
        # rounded rectangle test
        if x < radius and y < radius:
            return (x - radius) ** 2 + (y - radius) ** 2 <= radius ** 2
        if x > size - radius and y < radius:
            return (x - (size - radius)) ** 2 + (y - radius) ** 2 <= radius ** 2
        if x < radius and y > size - radius:
            return (x - radius) ** 2 + (y - (size - radius)) ** 2 <= radius ** 2
        if x > size - radius and y > size - radius:
            return (x - (size - radius)) ** 2 + (y - (size - radius)) ** 2 <= radius ** 2
        return True

    # Lightning bolt polygon (unit coords), clockwise
    bolt = [
        (0.58, 0.04), (0.24, 0.58), (0.46, 0.58),
        (0.38, 0.96), (0.76, 0.42), (0.52, 0.42), (0.64, 0.04),
    ]

    def in_bolt(px, py):
        x, y = px / size, py / size
        inside = False
        n = len(bolt)
        for i in range(n):
            x1, y1 = bolt[i]
            x2, y2 = bolt[(i + 1) % n]
            if (y1 > y) != (y2 > y):
                xint = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                if x < xint:
                    inside = not inside
        return inside

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            if not in_bg(x, y):
                row += b'\x00\x00\x00\x00'
                continue
            t = y / size
            r = round(99 + (67 - 99) * t)   # #6366f1 -> #4338ca
            g = round(102 + (56 - 102) * t)
            b = round(241 + (202 - 241) * t)
            if in_bolt(x, y):
                r, g, b = 255, 255, 255
            row += bytes((r, g, b, 255))
        rows.append(bytes(row))

    raw = b''.join(b'\x00' + r for r in rows)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


import os
os.makedirs('icons', exist_ok=True)
for s in (16, 32, 48, 128):
    with open(f'icons/icon{s}.png', 'wb') as f:
        f.write(make_png(s))
    print(f'icons/icon{s}.png written')
