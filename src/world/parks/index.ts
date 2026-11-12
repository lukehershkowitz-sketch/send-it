import type { ParkDef } from '../World';
import dirtline from './dirtline.json';
import proto from './proto.json';

export interface ParkEntry { id: string; name: string; blurb: string; def: ParkDef }

/** Parks are data: add a JSON layout here to make it selectable. */
export const PARKS: ParkEntry[] = [
  { id: 'dirtline', name: 'Dirt Line', blurb: 'Nine doubles through the pines, roll-in to finish.', def: dirtline as ParkDef },
  { id: 'proto', name: 'Proto Yard', blurb: 'One kicker, a rail and a ledge. The test yard.', def: proto as ParkDef },
];

export const parkById = (id: string) => PARKS.find((p) => p.id === id) ?? PARKS[0];
