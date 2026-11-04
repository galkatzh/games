// js/render/sky.js — WP-RENDER
// Sun, sky dome, haze. Low warm sun over the sea, so the west is the bright side of every street.
(function (TLV) {
  'use strict';

  var sky = TLV.ns('render.sky');

  var dome = null;
  var sun = null;
  var hemi = null;
  var amb = null;
  var scene0 = null;

  /** Uniform objects shared by reference with every patched material. */
  sky.U = null;

  /** World direction toward the sun, set in init. x east, y north, z up. */
  sky.toSun = { x: 0, y: 0, z: 1 };

  /** @returns {object} The directional light, or null before init. */
  sky.light = function () {
    return sun;
  };

  /** @returns {object} The dome mesh, or null before init. */
  sky.mesh = function () {
    return dome;
  };

  /** Display-space colour as a plain vec3, because fog runs after tone mapping and sRGB. */
  function display(hex) {
    var n = parseInt(hex.slice(1), 16);
    return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  var SKY_VERT = [
    'varying vec3 vDir;',
    'void main() {',
    '  vDir = position;',
    '  vec4 p = modelViewMatrix * vec4(position, 1.0);',
    '  gl_Position = projectionMatrix * p;',
    '}'
  ].join('\n');

  var SKY_FRAG = [
    'varying vec3 vDir;',
    'uniform vec3 uSunW, uHazeSun, uHazeAway, uZenith, uMid;',
    'float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }',
    'void main() {',
    '  vec3 d = normalize(vDir);',
    '  float up = max(d.y, 0.0);',
    '  vec3 sH = normalize(vec3(uSunW.x, 0.0, uSunW.z));',
    '  float s = dot(normalize(vec3(d.x, 1e-4, d.z)), sH) * 0.5 + 0.5;',
    '  vec3 hz = mix(uHazeAway, uHazeSun, s * s);',
    '  vec3 col = mix(hz, uMid, smoothstep(0.0, 0.22, up));',
    '  col = mix(col, uZenith, smoothstep(0.14, 0.8, up));',
    '  vec2 q = d.xz / (0.18 + up) * vec2(0.8, 2.2);',
    '  float c = vn(q * 1.3) * 0.6 + vn(q * 3.1 + 4.0) * 0.3 + vn(q * 7.3) * 0.1;',
    '  c = smoothstep(0.52, 0.8, c) * smoothstep(0.03, 0.2, up) * (1.0 - smoothstep(0.55, 0.95, up));',
    '  col = mix(col, vec3(1.0, 0.95, 0.88), c * 0.42);',
    '  float a = max(dot(d, uSunW), 0.0);',
    '  col += vec3(1.0, 0.86, 0.62) * (pow(a, 3000.0) * 1.2 + pow(a, 220.0) * 0.3 + pow(a, 14.0) * 0.1);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /**
   * Creates the sun, lights, haze and dome. Call once per render.init.
   * @param {object} scene THREE.Scene.
   * @param {{shadow:number}} quality Preset from TLV.tune.render.quality.
   */
  sky.init = function (scene, quality) {
    var T = TLV.tune.render;
    var az = T.sunAzimuthDeg * Math.PI / 180;
    var el = T.sunElevationDeg * Math.PI / 180;
    sky.toSun = { x: Math.cos(el) * Math.cos(az), y: Math.cos(el) * Math.sin(az), z: Math.sin(el) };
    var three = TLV.render.coords.toThree(sky.toSun.x, sky.toSun.y, sky.toSun.z, new THREE.Vector3());

    sky.U = {
      uSunW: { value: three.clone() },
      uHazeSun: { value: display(T.hazeSun) },
      uHazeAway: { value: display(T.hazeAway) },
      uTime: { value: 0 }
    };

    scene0 = scene;
    scene.fog = new THREE.Fog(new THREE.Color(T.hazeAway), T.fogNearM, T.fogFarM);

    hemi = new THREE.HemisphereLight(new THREE.Color(T.hemiSky), new THREE.Color(T.hemiGround), T.hemiIntensity);
    amb = new THREE.AmbientLight(new THREE.Color(T.ambient), T.ambientIntensity);
    sun = new THREE.DirectionalLight(new THREE.Color(T.sunColor), T.sunIntensity);
    sun.position.copy(three).multiplyScalar(T.shadowDepthM * 0.6);
    scene.add(hemi, amb, sun, sun.target);

    if (quality.shadow > 0) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(quality.shadow, quality.shadow);
      var c = sun.shadow.camera;
      c.left = -T.shadowHalfM;
      c.right = T.shadowHalfM;
      c.top = T.shadowHalfM;
      c.bottom = -T.shadowHalfM;
      c.near = 1;
      c.far = T.shadowDepthM;
      sun.shadow.bias = -0.0008;
      sun.shadow.normalBias = 0.35;
    }

    var mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSunW: sky.U.uSunW,
        uHazeSun: sky.U.uHazeSun,
        uHazeAway: sky.U.uHazeAway,
        uZenith: { value: display(T.skyZenith) },
        uMid: { value: display(T.skyMid) }
      }
    });
    dome = new THREE.Mesh(new THREE.SphereGeometry(100, 24, 14), mat);
    dome.renderOrder = -30;
    dome.frustumCulled = false;
    scene.add(dome);
  };

  /**
   * Follows the camera and the focus point.
   * @param {object} camera THREE.Camera the frame renders with.
   * @param {number} fx World x of the shadow focus.
   * @param {number} fy World y of the shadow focus.
   * @param {number} t Seconds, for water.
   */
  sky.frame = function (camera, fx, fy, t) {
    var T = TLV.tune.render;
    sky.fit(camera);
    sky.U.uTime.value = t;
    // Whole shadow texels, so edges hold still while the car moves.
    var texel = (T.shadowHalfM * 2) / Math.max(1, sun.shadow.mapSize.x);
    var sx = Math.round(fx / texel) * texel;
    var sy = Math.round(fy / texel) * texel;
    TLV.render.coords.toThree(sx, sy, 0, sun.target.position);
    sun.position.copy(sun.target.position).addScaledVector(sky.U.uSunW.value, T.shadowDepthM * 0.6);
    sun.target.updateMatrixWorld();
  };

  /**
   * Fits the dome inside a camera's far plane.
   * @param {object} camera THREE.Camera.
   */
  sky.fit = function (camera) {
    dome.position.copy(camera.position);
    dome.scale.setScalar(Math.min(camera.far * 0.9, 8000) / 100);
    dome.updateMatrixWorld();
  };

  /**
   * Adds world position and the directional haze to a Lambert-family shader. Call from onBeforeCompile.
   * @param {object} shader The shader object from onBeforeCompile.
   * @param {{near?:number,far?:number,max?:number}} [fog] Overrides, so far things can keep their shape.
   */
  sky.patch = function (shader, fog) {
    var T = TLV.tune.render;
    shader.uniforms.uSunW = sky.U.uSunW;
    shader.uniforms.uHazeSun = sky.U.uHazeSun;
    shader.uniforms.uHazeAway = sky.U.uHazeAway;
    shader.uniforms.uFogN = { value: (fog && fog.near) || T.fogNearM };
    shader.uniforms.uFogF = { value: (fog && fog.far) || T.fogFarM };
    shader.uniforms.uFogM = { value: (fog && fog.max) || T.fogMax };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <project_vertex>', [
        '#include <project_vertex>',
        '{ vec4 wp = vec4(transformed, 1.0);',
        '#ifdef USE_INSTANCING',
        '  wp = instanceMatrix * wp;',
        '#endif',
        '  vWP = (modelMatrix * wp).xyz; }'
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying vec3 vWP;',
        'uniform vec3 uSunW, uHazeSun, uHazeAway;',
        'uniform float uFogN, uFogF, uFogM;',
        'float gFogK = 1.0;',
        'vec3 hazeAt(vec3 d) {',
        '  float s = dot(normalize(vec3(d.x, 1e-4, d.z)), normalize(vec3(uSunW.x, 0.0, uSunW.z))) * 0.5 + 0.5;',
        '  return mix(uHazeAway, uHazeSun, s * s);',
        '}'
      ].join('\n'))
      .replace('#include <fog_fragment>', [
        '#ifdef USE_FOG',
        '{ vec3 toP = vWP - cameraPosition;',
        '  float fd = length(toP);',
        '  float ff = clamp((fd - uFogN) / (uFogF - uFogN), 0.0, 1.0);',
        '  ff = (1.0 - (1.0 - ff) * (1.0 - ff)) * uFogM * gFogK;',
        '  gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeAt(toP / max(fd, 0.01)), ff); }',
        '#endif'
      ].join('\n'));
  };

  /** Removes everything init added. */
  sky.dispose = function () {
    if (!scene0) return;
    scene0.remove(hemi, amb, sun, sun.target, dome);
    if (sun.shadow && sun.shadow.map) sun.shadow.map.dispose();
    dome.geometry.dispose();
    dome.material.dispose();
    dome = sun = hemi = amb = scene0 = null;
    sky.U = null;
  };
})(window.TLV);
