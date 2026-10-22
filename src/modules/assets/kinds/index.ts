import { AssetKindDescriptor } from '../asset-kind.interface';
import { AUDIO_DESCRIPTOR } from './audio/audio.descriptor';
import { FONT_DESCRIPTOR } from './font/font.descriptor';

/** Every kind the server can store, in the order the dashboard lists them. */
export const KIND_DESCRIPTORS: AssetKindDescriptor[] = [AUDIO_DESCRIPTOR, FONT_DESCRIPTOR];
