// Runtime layout also upgrades already-encrypted HTML without re-encryption.
export function installCompactArTransport({transport, playButton, seekSlider, document}) {
  transport.insertBefore(playButton, seekSlider);
  playButton.textContent = 'Ⅱ';
  playButton.setAttribute('aria-label', 'animationを一時停止');
  const style = document.createElement('style');
  style.textContent = `
    #transport { grid-template-columns: 44px minmax(60px, 1fr) auto; gap: 8px; }
    #transport #play-button { width: 44px; min-width: 44px; min-height: 44px;
      padding: 0; font-size: 22px; line-height: 1; pointer-events: auto; }
    #transport #rate-picker { min-width: 0; max-width: 42vw; }
    @media (max-width: 380px) {
      #transport { grid-template-columns: 44px minmax(0, 1fr); }
      #transport #rate-picker { grid-column: 1 / -1; justify-self: end; max-width: 100%; }
    }
  `;
  document.head.append(style);
}
