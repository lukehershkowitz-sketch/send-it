import type { ParkDef } from '../World';
import dirtline from './dirtline.json';
import proto from './proto.json';
import skatepark from './skatepark.json';
import plaza from './plaza.json';
import mega from './mega.json';
import vert from './vert.json';

export interface ParkEntry { id: string; name: string; blurb: string; def: ParkDef }

/** Parks are data: add a JSON layout here to make it selectable. */
export const PARKS: ParkEntry[] = [
  { id: 'dirtline', name: 'Dirt Line', blurb: 'Nine doubles through the pines, roll-in to finish.', def: dirtline as unknown as ParkDef },
  { id: 'skatepark', name: 'Skatepark', blurb: 'Quarters, a spine, a bowl corner, box jump, hubba and rails.', def: skatepark as unknown as ParkDef },
  { id: 'plaza', name: 'Street Plaza', blurb: 'Stairs, handrails, a hubba, ledges and a gap to bank.', def: plaza as unknown as ParkDef },
  { id: 'mega', name: 'Mega Ramp', blurb: 'An 11 m roll-in, a huge gap and a 6 m quarter.', def: mega as unknown as ParkDef },
  { id: 'vert', name: 'Vert', blurb: '60-second timed runs on a 3.6 m halfpipe.', def: vert as unknown as ParkDef },
  { id: 'proto', name: 'Proto Yard', blurb: 'One kicker, a rail and a ledge. The test yard.', def: proto as unknown as ParkDef },
];

export const parkById = (id: string) => PARKS.find((p) => p.id === id) ?? PARKS[0];
