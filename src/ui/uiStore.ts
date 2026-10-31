import { create } from 'zustand';

interface Ui {
  /** Un curseur est en cours de glissement : aperçu en basse résolution. */
  dragging: boolean;
  /** Affichage « avant » maintenu. */
  before: boolean;
  zoom: boolean;
  exportOpen: boolean;
  helpOpen: boolean;
  /** Pipette de balance des blancs active. */
  picking: boolean;
  hist: Hist | null;
}

export interface Hist { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array; total: number }

export const useUi = create<Ui>(() => ({ dragging: false, before: false, zoom: false, exportOpen: false, helpOpen: false, picking: false, hist: null }));

export const setDragging = (dragging: boolean) => { if (useUi.getState().dragging !== dragging) useUi.setState({ dragging }); };
