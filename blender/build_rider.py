"""
Builds the SEND IT rider + bike in Blender and exports public/models/rider.glb.

Run headless (no Blender UI needed):
    python3.11 -m venv .blenv && .blenv/bin/pip install bpy
    .blenv/bin/python blender/build_rider.py

Conventions (must match src/rider/RiderRig.ts):
  * Coordinates are authored in GAME space (+X left, +Y up, +Z forward, metres, origin =
    ground contact between the wheels) and converted to Blender space by P(); the glTF
    exporter converts back (Y-up), so the game receives exactly these numbers.
  * Every exported object is named  <part>__<material>, one material each. <material> is a
    key of RiderRig.mats, so the game recolours/re-shades them like the built-in parts.
  * Parts:
      frame   – bike space, rotates with the tailwhip pivot (incl. cranks, pedals, seat, pegs)
      front   – bike space, rotates with the barspin pivot (fork, stem, bars, grips, front pegs)
      wheel   – wheel-local, axle along X at the origin (used for both wheels)
      thigh, shin, upper, fore, torso, pelvis, shoe – UNIT space: the game stretches them
              (limbs: Y from -0.5 at the joint nearest the body to +0.5, radius 1)
      helmet, glove – metres, head / hand local
"""
import math
import os
import bpy
import bmesh
from mathutils import Matrix, Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'models', 'rider.glb')

# ----------------------------------------------------------------------------- scene / helpers
bpy.ops.wm.read_factory_settings(use_empty=True)
COLL = bpy.context.scene.collection
MATS = {}
PREVIEW = {  # preview colours only; the game swaps in its own materials by name
    'frame': (1, .35, .12), 'chrome': (.8, .82, .85), 'tire': (.1, .1, .1), 'rim': (.6, .62, .65), 'dark': (.16, .17, .19),
    'grip': (.05, .05, .05), 'accent': (1, .82, .25), 'chain': (.33, .35, .37), 'sidewall': (.42, .29, .17),
    'shirt': (.12, .7, .65), 'pants': (.17, .18, .23), 'skin': (.88, .65, .5), 'helmet': (.95, .95, .95),
    'visor': (.13, .13, .13), 'goggle': (1, .54, .24), 'shoe': (.91, .91, .91), 'sole': (.1, .1, .1), 'glove': (.17, .17, .19),
}


def mat(key):
    if key not in MATS:
        m = bpy.data.materials.new(key)
        m.diffuse_color = (*PREVIEW[key], 1)
        MATS[key] = m
    return MATS[key]


def P(x, y, z):
    """game (x left, y up, z forward) -> Blender (x, y, z-up)"""
    return Vector((x, -z, y))


def V(t):
    return P(*t)


def finish(obj, part, material, smooth=True, bevel=0.0, subsurf=0):
    obj['part'] = part
    obj['mkey'] = material
    obj.data.materials.clear()
    obj.data.materials.append(mat(material))
    for poly in obj.data.polygons:
        poly.use_smooth = smooth
    if bevel > 0:
        b = obj.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = 2
        b.harden_normals = True
    if subsurf:
        s = obj.modifiers.new('sub', 'SUBSURF')
        s.levels = subsurf
        s.render_levels = subsurf
    return obj


def new_obj(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    COLL.objects.link(ob)
    return ob


def tube(part, material, a, b, r, segs=12, r2=None, caps=True):
    """Cylinder between game-space points a and b (optionally tapered to r2)."""
    a, b = V(a), V(b)
    d = b - a
    bm = bmesh.new()
    res = bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r, radius2=r2 if r2 is not None else r, depth=d.length)
    rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=rot, verts=bm.verts)
    bmesh.ops.translate(bm, vec=(a + b) / 2, verts=bm.verts)
    return finish(new_obj(f'{part}_tube', bm), part, material)


def path_tube(part, material, pts, r, segs=12, steps=6):
    """Smoothly bent tube through game-space points (Catmull-Rom style curve, converted to mesh)."""
    cu = bpy.data.curves.new(f'{part}_curve', 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = r
    cu.bevel_resolution = max(1, segs // 4 - 1)
    cu.use_fill_caps = True
    cu.resolution_u = steps
    sp = cu.splines.new('BEZIER')
    sp.bezier_points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        bp = sp.bezier_points[i]
        bp.co = V(p)
        bp.handle_left_type = bp.handle_right_type = 'AUTO'
    ob = bpy.data.objects.new(f'{part}_path', cu)
    COLL.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    mo = bpy.data.objects.new(f'{part}_pathmesh', me)
    COLL.objects.link(mo)
    return finish(mo, part, material)


def sphere(part, material, c, r, scale=(1, 1, 1), segs=16, rings=10):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=r)
    sx, sy, sz = scale  # game axes
    bmesh.ops.scale(bm, vec=(sx, sz, sy), verts=bm.verts)
    bmesh.ops.translate(bm, vec=V(c), verts=bm.verts)
    return finish(new_obj(f'{part}_sph', bm), part, material)


def box(part, material, c, size, bevel=0.0, subsurf=0, rot=None):
    """Box centred at game point c with game-axis size (x, y, z)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    sx, sy, sz = size
    bmesh.ops.scale(bm, vec=(sx, sz, sy), verts=bm.verts)
    if rot:
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=rot, verts=bm.verts)
    bmesh.ops.translate(bm, vec=V(c), verts=bm.verts)
    return finish(new_obj(f'{part}_box', bm), part, material, smooth=bevel > 0 or subsurf > 0, bevel=bevel, subsurf=subsurf)


def torus_x(part, material, c, R, r, maj=32, mino=10):
    """Torus whose axis is the game X axis (wheels), centred at game point c."""
    bm = bmesh.new()
    for i in range(maj):
        a = 2 * math.pi * i / maj
        for j in range(mino):
            b = 2 * math.pi * j / mino
            rr = R + r * math.cos(b)
            x = r * math.sin(b)
            bm.verts.new(V((c[0] + x, c[1] + rr * math.sin(a), c[2] + rr * math.cos(a))))
    bm.verts.ensure_lookup_table()
    for i in range(maj):
        for j in range(mino):
            a0, a1 = i, (i + 1) % maj
            b0, b1 = j, (j + 1) % mino
            bm.faces.new([bm.verts[a0 * mino + b0], bm.verts[a1 * mino + b0], bm.verts[a1 * mino + b1], bm.verts[a0 * mino + b1]])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return finish(new_obj(f'{part}_torus', bm), part, material)


def loft(part, material, rings, segs=18, cap_top=0.06, cap_bottom=0.06):
    """Closed shape from elliptical rings (y, rx, rz) in game space, with domed ends."""
    bm = bmesh.new()
    loops = []
    for (y, rx, rz) in rings:
        loops.append([bm.verts.new(V((rx * math.cos(2 * math.pi * k / segs), y, rz * math.sin(2 * math.pi * k / segs)))) for k in range(segs)])
    for l0, l1 in zip(loops, loops[1:]):
        for k in range(segs):
            bm.faces.new([l0[k], l0[(k + 1) % segs], l1[(k + 1) % segs], l1[k]])
    for loop, (y, rx, rz), dy in ((loops[0], rings[0], -cap_bottom), (loops[-1], rings[-1], cap_top)):
        c = bm.verts.new(V((0, y + dy, 0)))
        for k in range(segs):
            bm.faces.new([loop[k], loop[(k + 1) % segs], c])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return finish(new_obj(f'{part}_loft', bm), part, material)


# ============================================================================= BIKE (bike space)
RA, FA, BB = (0, .257, -.49), (0, .257, .49), (0, .30, -.06)
SEAT, HT_TOP, HT_BOT = (0, .74, -.24), (0, .84, .31), (0, .65, .365)


def lerp3(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


# frame tubes (slightly tapered, with welded joints)
tube('frame', 'frame', SEAT, HT_TOP, .023, 16, .021)
tube('frame', 'frame', BB, HT_BOT, .028, 16, .025)
tube('frame', 'frame', BB, SEAT, .023, 16)
ht_dir = Vector(HT_TOP) - Vector(HT_BOT)
tube('frame', 'frame', tuple(Vector(HT_BOT) - ht_dir * .12), tuple(Vector(HT_TOP) + ht_dir * .1), .033, 20)
for s in (1, -1):
    tube('frame', 'frame', (s * .03, BB[1], BB[2]), (s * .056, RA[1], RA[2] + .01), .017, 12, .013)
    tube('frame', 'frame', (s * .018, SEAT[1] - .02, SEAT[2]), (s * .056, RA[1] + .02, RA[2] + .015), .015, 12, .012)
    box('frame', 'frame', (s * .058, RA[1], RA[2] - .01), (.008, .06, .085), bevel=.002)  # dropouts
    tube('frame', 'chrome', (s * .062, RA[1], RA[2]), (s * .075, RA[1], RA[2]), .014, 6)  # axle nuts
for c, r in ((SEAT, .027), (BB, .02)):
    sphere('frame', 'frame', c, r)
tube('frame', 'frame', (.055, BB[1], BB[2]), (-.055, BB[1], BB[2]), .036, 20)  # BB shell
# gussets under the top tube / head tube joint
box('frame', 'frame', lerp3(HT_TOP, HT_BOT, .25), (.012, .07, .05), bevel=.004)
# headset cups
for c in (tuple(Vector(HT_TOP) + ht_dir * .1), tuple(Vector(HT_BOT) - ht_dir * .12)):
    tube('frame', 'dark', tuple(Vector(c) - ht_dir * .03), tuple(Vector(c) + ht_dir * .03), .037, 20)
# seat post, clamp, saddle
tube('frame', 'chrome', SEAT, (0, SEAT[1] + .085, SEAT[2] - .03), .0145, 12)
tube('frame', 'dark', (0, SEAT[1] - .01, SEAT[2]), (0, SEAT[1] + .025, SEAT[2] - .01), .02, 14)
box('frame', 'dark', (0, SEAT[1] + .105, SEAT[2] - .035), (.1, .045, .23), subsurf=2)
# cranks, spindle, pedals, sprocket, cog, chain
tube('frame', 'chrome', (.105, BB[1], BB[2]), (-.105, BB[1], BB[2]), .011, 10)
PED_L, PED_R = (.14, .30, .115), (-.14, .30, -.235)
for side, ped in ((1, PED_L), (-1, PED_R)):
    tube('frame', 'dark', (side * .09, BB[1], BB[2]), (side * .09, ped[1], ped[2]), .016, 10, .013)
    sphere('frame', 'dark', (side * .09, ped[1], ped[2]), .017)
    box('frame', 'dark', ped, (.105, .022, .095), bevel=.006)
    tube('frame', 'chrome', (side * .09, ped[1], ped[2]), (side * .19, ped[1], ped[2]), .006, 6)
    for px in (-.035, .035):  # pins
        for pz in (-.032, .032):
            tube('frame', 'chrome', (ped[0] + px, ped[1] + .011, ped[2] + pz), (ped[0] + px, ped[1] + .017, ped[2] + pz), .003, 5)
# sprocket: toothed disc with a spider
bm = bmesh.new()
teeth, R0, R1 = 25, .085, .093
outline = []
for i in range(teeth * 2):
    a = math.pi * i / teeth
    r = R1 if i % 2 == 0 else R0
    outline.append(bm.verts.new(V((-.05, BB[1] + r * math.sin(a), BB[2] + r * math.cos(a)))))
face = bm.faces.new(outline)
ext = bmesh.ops.extrude_face_region(bm, geom=[face])
bmesh.ops.translate(bm, vec=V((.004, 0, 0)), verts=[v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
finish(new_obj('sprocket', bm), 'frame', 'chrome', smooth=False)
tube('frame', 'accent', (-.045, BB[1], BB[2]), (-.06, BB[1], BB[2]), .045, 24)
tube('frame', 'chrome', (-.05, RA[1], RA[2]), (-.054, RA[1], RA[2]), .036, 18)
links = 34
for dy in (1, -1):
    a, b = (-.05, BB[1] + .089 * dy, BB[2]), (-.05, RA[1] + .036 * dy, RA[2])
    for i in range(links):
        c = lerp3(a, b, (i + .5) / links)
        box('frame', 'chain', c, (.007, .009, .011))
# rear pegs (knurled)
for s in (1, -1):
    tube('frame', 'chrome', (s * .078, RA[1], RA[2]), (s * .19, RA[1], RA[2]), .022, 16)
    for k in range(4):
        x = s * (.095 + k * .025)
        torus_x('frame', 'dark', (x, RA[1], RA[2]), .022, .0025, 18, 4)

# ----------------------------------------------------------------------------- front end
for s in (1, -1):
    path_tube('front', 'chrome', [(s * .05, HT_BOT[1] - .02, HT_BOT[2] + .005), (s * .052, .45, .43), (s * .05, FA[1] + .01, FA[2])], .017, 12)
    box('front', 'chrome', (s * .05, FA[1], FA[2]), (.01, .04, .03), bevel=.003)
box('front', 'chrome', (0, HT_BOT[1] - .03, HT_BOT[2] + .008), (.14, .035, .05), bevel=.008)  # crown
tube('front', 'chrome', tuple(Vector(HT_BOT) - ht_dir * .1), tuple(Vector(HT_TOP) + ht_dir * .2), .0145, 12)  # steerer
STEM = (0, .885, .335)
box('front', 'dark', (0, .87, .325), (.06, .045, .075), bevel=.01)  # stem body
for s in (1, -1):
    tube('front', 'dark', (s * .035, STEM[1], STEM[2]), (s * .06, STEM[1], STEM[2]), .02, 14)  # clamps
# bars: centre, risers, crossbar, upper bars to the grips
tube('front', 'chrome', (-.075, STEM[1], STEM[2]), (.075, STEM[1], STEM[2]), .0115, 12)
for s in (1, -1):
    path_tube('front', 'chrome', [(s * .075, STEM[1], STEM[2]), (s * .1, STEM[1] + .015, STEM[2] - .002), (s * .225, 1.035, .29), (s * .26, 1.05, .282)], .0115, 12)
    tube('front', 'chrome', (s * .255, 1.05, .282), (s * .3, 1.052, .272), .0115, 12)
    tube('front', 'grip', (s * .27, 1.051, .276), (s * .375, 1.054, .262), .0165, 14)
    tube('front', 'grip', (s * .268, 1.051, .276), (s * .274, 1.051, .275), .024, 14)  # flange
    tube('front', 'accent', (s * .375, 1.054, .262), (s * .384, 1.054, .261), .018, 14)  # bar end
tube('front', 'chrome', (-.16, .965, .31), (.16, .965, .31), .009, 10)  # crossbar
for s in (1, -1):  # front pegs
    tube('front', 'chrome', (s * .062, FA[1], FA[2]), (s * .18, FA[1], FA[2]), .022, 16)
    for k in range(4):
        torus_x('front', 'dark', (s * (.09 + k * .025), FA[1], FA[2]), .022, .0025, 18, 4)

# ----------------------------------------------------------------------------- wheel (local, axle = X)
O = (0, 0, 0)
torus_x('wheel', 'tire', O, .222, .036, 48, 12)
torus_x('wheel', 'sidewall', O, .205, .013, 48, 6)
torus_x('wheel', 'rim', O, .19, .015, 48, 8)
for i in range(44):  # tread knobs, staggered in two rows
    a = 2 * math.pi * i / 44
    for row in ((-.017,) if i % 2 else (.017,)) + ((0.0,) if i % 4 == 0 else ()):
        c = (row, .255 * math.sin(a), .255 * math.cos(a))
        box('wheel', 'tire', c, (.016, .016, .014), rot=Matrix.Rotation(math.pi / 2 - a, 3, 'X'))
tube('wheel', 'chrome', (-.055, 0, 0), (.055, 0, 0), .02, 16)  # hub
for s in (1, -1):
    tube('wheel', 'chrome', (s * .03, 0, 0), (s * .036, 0, 0), .032, 20)  # flanges
for i in range(36):  # 3-cross spokes
    side = 1 if i % 2 == 0 else -1
    a = 2 * math.pi * i / 36
    a2 = a + side * 2 * math.pi * 3 / 36 * (1 if (i // 2) % 2 == 0 else -1)
    tube('wheel', 'rim', (side * .033, .029 * math.sin(a), .029 * math.cos(a)), (side * .006, .178 * math.sin(a2), .178 * math.cos(a2)), .0016, 5, caps=False)
tube('wheel', 'chrome', (0, .2, 0.0), (0, .222, 0.0), .004, 6)  # valve

# ============================================================================= RIDER
# limbs: unit space, Y -0.5 (joint nearest the body) → +0.5, radius 1 (game scales by length/radius)
loft('thigh', 'pants', [(-.5, 1.0, .95), (-.32, 1.03, .98), (-.05, .97, .93), (.22, .88, .85), (.5, .8, .78)], 18, .08, .06)
loft('shin', 'pants', [(-.5, .86, .84), (-.25, .9, .88), (.05, .82, .8), (.32, .72, .71), (.5, .78, .76)], 18, .05, .05)
loft('upper', 'shirt', [(-.5, 1.05, 1.0), (-.2, 1.0, .98), (.2, .9, .88), (.5, .86, .84)], 16, .1, .05)
loft('fore', 'shirt', [(-.5, .95, .92), (-.15, .92, .9), (.25, .78, .76), (.4, .74, .72)], 16, .04, .02)
loft('fore', 'glove', [(.38, .84, .82), (.5, .8, .78)], 16, .02, .04)
# torso: unit box space (game scales x .36, y length, z .2): waist → chest → shoulders
loft('torso', 'shirt', [(-.5, .38, .42), (-.32, .38, .4), (-.1, .42, .43), (.14, .5, .48), (.32, .55, .46), (.42, .5, .38), (.49, .3, .26)], 24, .05, .04)
box('pelvis', 'pants', (0, 0, 0), (1, 1, 1), subsurf=2)
# shoe: unit box space (game scales .1 x .07 x .24), toe toward +Z
box('shoe', 'shoe', (0, .08, -.02), (.95, .8, .9), subsurf=2)
box('shoe', 'sole', (0, -.33, 0), (1.04, .32, 1.04), bevel=.06)
box('shoe', 'accent', (0, .02, .1), (1.0, .12, .5), subsurf=1)
# glove: metres, hand local
sphere('glove', 'glove', (0, 0, .005), .046, (0.85, 0.75, 1.15))
sphere('glove', 'glove', (.03, -.005, -.01), .018, (1, 1, 1.4))
# helmet: metres, head local (+Z = face)
loft('helmet', 'helmet', [(-.07, .092, .1), (-.035, .122, .138), (.02, .143, .162), (.09, .136, .152), (.14, .098, .108)], 26, .02, .0)
bm = bmesh.new()  # chin bar: half torus around the jaw
segs, rings, R, r = 18, 8, .115, .03
for i in range(segs + 1):
    a = math.pi * i / segs
    for j in range(rings):
        b = 2 * math.pi * j / rings
        rr = R + r * math.cos(b)
        bm.verts.new(V((rr * math.cos(a), -.085 + r * math.sin(b), .02 + rr * math.sin(a) * 1.05)))
bm.verts.ensure_lookup_table()
for i in range(segs):
    for j in range(rings):
        bm.faces.new([bm.verts[i * rings + j], bm.verts[(i + 1) * rings + j], bm.verts[(i + 1) * rings + (j + 1) % rings], bm.verts[i * rings + (j + 1) % rings]])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
finish(new_obj('chin', bm), 'helmet', 'helmet')
sphere('helmet', 'visor', (0, -.03, .095), .07, (1.15, .7, .55))  # dark face opening
box('helmet', 'helmet', (0, .095, .17), (.21, .014, .15), subsurf=1)  # peak
box('helmet', 'goggle', (0, .015, .14), (.2, .055, .04), subsurf=1)
loft('helmet', 'visor', [(-.012, .158, .17), (.012, .158, .17)], 28, 0, 0)  # goggle strap
box('helmet', 'accent', (0, .14, -.01), (.04, .03, .26), subsurf=1)  # stripe

# ============================================================================= join + export
groups = {}
for ob in list(COLL.objects):
    if ob.type != 'MESH' or 'part' not in ob:
        continue
    groups.setdefault(f"{ob['part']}__{ob['mkey']}", []).append(ob)
for name, obs in groups.items():
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    if len(obs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', export_apply=True, export_yup=True,
    export_texcoords=False, export_normals=True, export_materials='EXPORT', export_extras=False,
)
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in COLL.objects if o.type == 'MESH')
print(f'exported {len(groups)} objects, ~{tris} tris (before modifiers) -> {os.path.normpath(OUT)}')
