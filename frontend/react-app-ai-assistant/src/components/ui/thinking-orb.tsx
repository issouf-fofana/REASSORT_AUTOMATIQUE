// Indicateur "en train de réfléchir" (entre l'envoi de la question et le premier mot de la
// réponse) : le vrai logo Réassort Automatique qui tourne sur lui-même, dans un badge marine —
// remplace la sphère de points abstraite du premier essai (08/10/2026), jugée sans rapport avec le
// produit ("il faut que ce soit le logo de reassort"). Rotation 3D en CSS pur (perspective +
// rotateY), pas de canvas : plus simple, moins coûteux, et le logo réel se reconnaît tout de suite.
export function ThinkingOrb({ size = 34 }: { size?: number }) {
  return (
    <span
      className="aia-thinking-logo-wrap"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="aia-thinking-logo-spin">
        <img src="/assets/images/logo-reassort.png" alt="" style={{ width: size * 0.62, height: size * 0.62 }} />
      </span>
    </span>
  );
}
