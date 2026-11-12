"""
Builds SEND IT's scenery kit in Blender and exports public/models/scenery.glb.

    .blenv/bin/python blender/build_scenery.py      (see build_rider.py for the venv)

Every object is named <kind>__<material>, authored in game space (+Y up, metres) with its base
at the origin. The game instances each kind many times (src/world/decor.ts), so one kind = a
few draw calls no matter how many are placed. Materials are tinted per instance in the game;
the colours here are only previews.
  pine_a, pine_b, oak, birch, bush, stump, grass         (natural)
  rock_a, rock_b, rock_c                                   (rocks)
  building_a, building_b, building_c, bench, bin, railing  (urban)
  lamp                                                     (night lighting post)
"""
import math
import os
import random
import bpy
import bmesh
from mathutils import Matrix, Vector, noise

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'models', 'scenery.glb')
bpy.ops.wm.read_factory_settings(use_empty=True)
COLL = bpy.context.scene.collection
rng = random.Random(11)
PREVIEW = {
    'leaves': (.25, .5, .25), 'bark': (.35, .25, .17), 'birchbark': (.9, .9, .86), 'rock': (.55, .55, .52),
    'grass': (.35, .55, .25), 'wall': (.75, .68, .6), 'window': (.15, .2, .28), 'roof': (.3, .3, .32),
    'trim': (.85, .85, .82), 'wood': (.55, .38, .22), 'metal': (.35, .37, .4), 'bulb': (1, .9, .7), 'awning': (.7, .2, .2),
}
MATS = {}


def mat(k):
    if k not in MATS:
        m = bpy.data.materials.new(k)
        m.diffuse_color = (*PREVIEW[k], 1)
        MATS[k] = m
    return MATS[k]


def P(x, y, z):
    return Vector((x, -z, y))


def obj_from(bm, kind, material, smooth=False):
    me = bpy.data.meshes.new(kind)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    ob = bpy.data.objects.new(kind, me)
    ob['kind'], ob['mkey'] = kind, material
    me.materials.append(mat(material))
    COLL.objects.link(ob)
    return ob


def place(bm, verts, pos=(0, 0, 0), rot_y=0.0, scale=(1, 1, 1)):
    """Scale (game axes), rotate about game Y, then translate to game pos."""
    sx, sy, sz = scale
    bmesh.ops.scale(bm, vec=(sx, sz, sy), verts=verts)
    bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(rot_y, 3, 'Z'), verts=verts)
    bmesh.ops.translate(bm, vec=P(*pos), verts=verts)


def cone(bm, r1, r2, h, segs, pos=(0, 0, 0), jitter=0.0, rot=0.0):
    res = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=True, segments=segs, radius1=r1, radius2=r2, depth=h)
    vs = res['verts']
    bmesh.ops.translate(bm, vec=(0, 0, h / 2), verts=vs)
    if jitter:
        for v in vs:
            if v.co.z > 0.01 and v.co.z < h - 0.01:
                v.co.x += rng.uniform(-jitter, jitter)
                v.co.y += rng.uniform(-jitter, jitter)
    place(bm, vs, pos, rot)
    return vs


def blob(bm, r, pos, squash=(1, 1, 1), subdiv=1, amp=0.18, seed=0.0):
    """Lumpy icosphere (foliage clumps, rocks)."""
    res = bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=r)
    vs = res['verts']
    for v in vs:
        n = noise.noise(v.co * (2.2 / r) + Vector((seed, seed * 1.7, seed * 0.3)))
        v.co *= 1 + amp * n
    place(bm, vs, pos, rng.uniform(0, 6.28), squash)
    return vs


def box(bm, size, pos, rot=0.0):
    res = bmesh.ops.create_cube(bm, size=1)
    vs = res['verts']
    bmesh.ops.translate(bm, vec=(0, 0, 0.5), verts=vs)  # base at y=0
    place(bm, vs, pos, rot, size)
    return vs


def part(kind, material, build, smooth=False):
    bm = bmesh.new()
    build(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from(bm, kind, material, smooth)


# ============================================================================= trees
def pine(kind, tiers, height, width):
    trunk_h = height * 0.22
    part(kind, 'bark', lambda bm: cone(bm, width * 0.09, width * 0.05, trunk_h + height * 0.3, 7))

    def foliage(bm):
        y = trunk_h
        th = (height - trunk_h) / tiers * 1.55
        for i in range(tiers):
            k = 1 - i / tiers
            cone(bm, width * (0.25 + 0.75 * k), 0.0 if i == tiers - 1 else width * 0.1 * k, th, 9, (0, y, 0), jitter=width * 0.05, rot=i * 0.7)
            y += th * 0.55
    part(kind, 'leaves', foliage)


pine('pine_a', 4, 10.0, 2.6)
pine('pine_b', 6, 14.0, 2.2)


def oak():
    def trunk(bm):
        cone(bm, .32, .2, 3.4, 8)
        for a, tilt in ((0.4, .5), (2.4, .6), (4.3, .45)):  # branches
            vs = cone(bm, .12, .06, 2.0, 6)
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(tilt, 3, 'X') @ Matrix.Rotation(a, 3, 'Z'), verts=vs)
            bmesh.ops.translate(bm, vec=P(0, 2.6, 0), verts=vs)
    part('oak', 'bark', trunk)

    def canopy(bm):
        for (x, y, z, r) in ((0, 5.2, 0, 2.3), (1.4, 4.6, .6, 1.6), (-1.3, 4.7, -.5, 1.7), (.3, 4.4, -1.4, 1.5), (-.4, 6.2, .5, 1.5), (.8, 5.6, 1.3, 1.3)):
            blob(bm, r, (x, y, z), (1, .85, 1), 1, .22, seed=x + z)
    part('oak', 'leaves', canopy)


oak()


def birch():
    part('birch', 'birchbark', lambda bm: cone(bm, .15, .07, 7.0, 7))

    def marks(bm):  # dark bark marks, slightly proud of the trunk
        for i in range(9):
            y = 0.6 + i * 0.7 + rng.uniform(-.1, .1)
            r = .15 - .08 * y / 7.0 + .006
            vs = box(bm, (r * 1.2, .05, .02), (0, y, 0), rng.uniform(0, 6.28))
            bmesh.ops.translate(bm, vec=P(r * 0.7 * math.cos(i), 0, r * 0.7 * math.sin(i)), verts=vs)
    part('birch', 'bark', marks)

    def canopy(bm):
        for (x, y, z, r) in ((0, 6.3, 0, 1.5), (.7, 5.4, .3, 1.1), (-.6, 5.6, -.4, 1.0), (.1, 4.7, .6, .9)):
            blob(bm, r, (x, y, z), (.9, 1.15, .9), 1, .25, seed=y)
    part('birch', 'leaves', canopy)


birch()


def bush(bm):
    for (x, z, r) in ((0, 0, .75), (.6, .2, .55), (-.5, .3, .5), (.1, -.5, .5)):
        blob(bm, r, (x, r * .55, z), (1, .8, 1), 1, .25, seed=x * 3 + z)


part('bush', 'leaves', bush)
part('stump', 'bark', lambda bm: cone(bm, .38, .32, .45, 9, jitter=.03))


def grass(bm):
    for i in range(11):  # crossed blades
        a = rng.uniform(0, math.pi)
        h = rng.uniform(.25, .5)
        x, z = rng.uniform(-.15, .15), rng.uniform(-.15, .15)
        lean = Vector((rng.uniform(-.08, .08), 0, rng.uniform(-.08, .08)))
        w = .035
        dx, dz = math.cos(a) * w, math.sin(a) * w
        v = [bm.verts.new(P(x - dx, 0, z - dz)), bm.verts.new(P(x + dx, 0, z + dz)), bm.verts.new(P(x + lean.x, h, z + lean.z))]
        bm.faces.new(v)


part('grass', 'grass', grass)

# ============================================================================= rocks
for i, (sq, amp) in enumerate((((1.2, .7, 1.0), .28), ((1, 1, 1), .35), ((1.6, .5, 1.1), .22))):
    part(f'rock_{"abc"[i]}', 'rock', lambda bm, sq=sq, amp=amp, i=i: blob(bm, 1.0, (0, .35, 0), sq, 2, amp, seed=i * 5.3))

# ============================================================================= urban
def building(kind, w, d, floors, fh=3.0, shop=False):
    H = floors * fh

    def walls(bm):
        box(bm, (w, H, d), (0, 0, 0))
        box(bm, (w + .3, .5, d + .3), (0, H, 0))  # parapet base
        if shop:
            box(bm, (w + .1, .25, d + .1), (0, fh, 0))
    part(kind, 'wall', walls)

    def trim(bm):
        for f in range(1, floors):
            box(bm, (w + .08, .12, d + .08), (0, f * fh - .06, 0))
        box(bm, (w + .4, .15, d + .4), (0, H + .5, 0))
    part(kind, 'trim', trim)

    def windows(bm):
        for face in range(4):
            span = w if face % 2 == 0 else d
            n = max(1, int(span / 2.6))
            for f in range(floors):
                if shop and f == 0:
                    continue
                for k in range(n):
                    u = -span / 2 + span * (k + .5) / n
                    off = (d if face % 2 == 0 else w) / 2 + .02
                    y = f * fh + .9
                    if face == 0: pos = (u, y, off)
                    elif face == 1: pos = (off, y, u)
                    elif face == 2: pos = (u, y, -off)
                    else: pos = (-off, y, u)
                    rot = 0 if face % 2 == 0 else math.pi / 2
                    box(bm, (1.3, 1.5, .06), pos, rot)
        if shop:  # big shop window + door on the front
            box(bm, (w * .7, 1.9, .06), (-w * .1, .5, d / 2 + .02))
            box(bm, (1.1, 2.2, .06), (w * .38, 0, d / 2 + .02))
    part(kind, 'window', windows)

    def roof(bm):
        box(bm, (w - .4, .08, d - .4), (0, H, 0))
        box(bm, (1.6, 1.0, 1.0), (w * .25, H, -d * .2))  # AC units
        box(bm, (1.0, .8, 1.4), (-w * .3, H, d * .15))
        cone(bm, .9, .9, 1.8, 10, (-w * .15, H + .3, -d * .25))  # water tank
    part(kind, 'roof', roof)
    if shop:
        def awning(bm):
            vs = box(bm, (w * .8, .12, 1.4), (0, 2.6, d / 2 + .7))
            bmesh.ops.rotate(bm, cent=P(0, 2.66, d / 2), matrix=Matrix.Rotation(-.25, 3, 'X'), verts=vs)
        part(kind, 'awning', awning)


building('building_a', 12, 10, 4)
building('building_b', 8, 8, 7)
building('building_c', 14, 9, 2, 3.4, shop=True)


def bench():
    def wood(bm):
        for k in range(3):
            box(bm, (1.8, .04, .1), (0, .45, -.12 + k * .12))
        for k in range(2):
            vs = box(bm, (1.8, .1, .04), (0, .62 + k * .14, -.22))
    part('bench', 'wood', wood)

    def legs(bm):
        for x in (-.75, .75):
            box(bm, (.06, .45, .36), (x, 0, 0))
            box(bm, (.06, .38, .05), (x, .45, -.22))
    part('bench', 'metal', legs)


bench()


def bin_():
    part('bin', 'metal', lambda bm: (cone(bm, .27, .3, .85, 14), cone(bm, .32, .32, .05, 14, (0, .85, 0))))


bin_()


def railing():  # 4 m metal railing section
    def build(bm):
        for x in (-2, 0, 2):
            cone(bm, .03, .03, 1.0, 6, (x, 0, 0))
        for y in (.5, .98):
            vs = cone(bm, .022, .022, 4.0, 6)
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'), verts=vs)
            bmesh.ops.translate(bm, vec=P(2, y, 0), verts=vs)
    part('railing', 'metal', build, smooth=True)


railing()


def lamp():  # 5.5 m street lamp; bulb at (0.9, 5.4, 0)
    def metal(bm):
        cone(bm, .12, .07, 5.5, 10)
        cone(bm, .2, .2, .25, 10)  # base
        vs = cone(bm, .04, .04, 1.0, 6)
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'), verts=vs)
        bmesh.ops.translate(bm, vec=P(0, 5.45, 0), verts=vs)
        cone(bm, .28, .1, .22, 12, (.9, 5.35, 0))  # head
    part('lamp', 'metal', metal, smooth=True)
    part('lamp', 'bulb', lambda bm: blob(bm, .12, (.9, 5.33, 0), (1, .5, 1), 1, 0, 0), smooth=True)


lamp()

# ============================================================================= join + export
groups = {}
for ob in list(COLL.objects):
    groups.setdefault(f"{ob['kind']}__{ob['mkey']}", []).append(ob)
for name, obs in groups.items():
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    if len(obs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = ob.data.name = name

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_apply=True, export_yup=True,
                          export_texcoords=False, export_normals=True, export_materials='EXPORT', export_extras=False)
tris = {n: sum(len(p.vertices) - 2 for p in bpy.data.objects[n].data.polygons) for n in groups}
for n in sorted(tris):
    print(f'{n:24} {tris[n]:5} tris')
print('->', os.path.normpath(OUT))
