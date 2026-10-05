// Card coordinates: +X long edge, +Y short edge, +Z out of the printed face.
// Dimensions below are canonical metres, not measured physical print size.
export const boxSpecification = Object.freeze({
  cardWidthM: 0.091, cardHeightM: 0.055,
  boxWidthM: 0.030, boxHeightM: 0.020, boxDepthM: 0.015, liftM: 0.005,
});

export function createBox(THREE) {
  const spec = boxSpecification;
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(spec.boxWidthM, spec.boxHeightM, spec.boxDepthM);
  const material = new THREE.MeshBasicMaterial({ color: 0x109fa9, transparent: true, opacity: 0.72 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = spec.liftM + spec.boxDepthM / 2;
  group.add(mesh);
  const edgeGeometry = new THREE.EdgesGeometry(geometry);
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
  const edge = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edge.position.copy(mesh.position);
  group.add(edge);
  const outlineGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-spec.cardWidthM / 2, -spec.cardHeightM / 2, 0),
    new THREE.Vector3(spec.cardWidthM / 2, -spec.cardHeightM / 2, 0),
    new THREE.Vector3(spec.cardWidthM / 2, spec.cardHeightM / 2, 0),
    new THREE.Vector3(-spec.cardWidthM / 2, spec.cardHeightM / 2, 0),
    new THREE.Vector3(-spec.cardWidthM / 2, -spec.cardHeightM / 2, 0),
  ]);
  const outlineMaterial = new THREE.LineBasicMaterial({ color: 0xffa960 });
  group.add(new THREE.Line(outlineGeometry, outlineMaterial));
  const directionGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.019, 0, 0.0002), new THREE.Vector3(0.019, 0, 0.0002),
    new THREE.Vector3(0.019, 0, 0.0002), new THREE.Vector3(0.014, 0.004, 0.0002),
    new THREE.Vector3(0.019, 0, 0.0002), new THREE.Vector3(0.014, -0.004, 0.0002),
  ]);
  const directionMaterial = new THREE.LineBasicMaterial({ color: 0xffa960 });
  group.add(new THREE.LineSegments(directionGeometry, directionMaterial));
  return { group, dispose() {
    group.removeFromParent();
    for (const item of [geometry, material, edgeGeometry, edgeMaterial, outlineGeometry,
      outlineMaterial, directionGeometry, directionMaterial]) item.dispose();
  } };
}
