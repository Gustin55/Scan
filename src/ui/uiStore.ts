import { create } from 'zustand';

interface Ui {
  /** Un curseur est en cours de glissement : aperçu en basse résolution. */
  dragging: boolean;
  /** Affichage « avant » maintenu. */
  before: boolean;
  zoom: boolean;
  exportOpen: boolean;
  helpOpen: boolean;
}

export const useUi = create<Ui>(() => ({ dragging: false, before: false, zoom: false, exportOpen: false, helpOpen: false }));

export const setDragging = (dragging: boolean) => { if (useUi.getState().dragging !== dragging) useUi.setState({ dragging }); };
