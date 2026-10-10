// The studio behind the glass: four soft pools of light (blue, pink, green, yellow) drifting
// slowly, and the brand's four light lines at architectural scale. Glass surfaces bend and blur
// this layer, which is what makes them read as liquid glass rather than flat white boxes.
export default function StudioLights() {
  return (
    <div className="studio" aria-hidden="true">
      <span className="studio-pool studio-blue" />
      <span className="studio-pool studio-pink" />
      <span className="studio-pool studio-green" />
      <span className="studio-pool studio-yellow" />
      <span className="studio-lines" />
    </div>
  )
}
