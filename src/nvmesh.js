import * as gifti from "gifti-reader-js/release/current/gifti-reader";
import * as fflate from "fflate";
import { v4 as uuidv4 } from "uuid";
import * as cmaps from "./cmaps";
import { Log } from "./logger";
import { NiivueObject3D } from "./niivue-object3D.js"; //n.b. used by connectome
import { mat3, mat4, vec3, vec4 } from "gl-matrix";
import { colortables } from "./colortables";
const cmapper = new colortables();
const log = new Log();
/**
 * @class NVMesh
 * @type NVMesh
 * @description
 * a NVImage encapsulates some images data and provides methods to query and operate on images
 * @constructor
 * @param {array} dataBuffer an array buffer of image data to load (there are also methods that abstract this more. See loadFromUrl, and loadFromFile)
 * @param {string} [name=''] a name for this image. Default is an empty string
 * @param {number} [opacity=1.0] the opacity for this image. default is 1
 * @param {boolean} [trustCalMinMax=true] whether or not to trust cal_min and cal_max from the nifti header (trusting results in faster loading)
 * @param {number} [percentileFrac=0.02] the percentile to use for setting the robust range of the display values (smart intensity setting for images with large ranges)
 * @param {boolean} [ignoreZeroVoxels=false] whether or not to ignore zero voxels in setting the robust range of display values
 * @param {boolean} [visible=true] whether or not this image is to be visible
 */
export function NVMesh(
  pts,
  tris,
  name = "",
  rgba255 = [1, 0, 0, 0],
  opacity = 1.0,
  visible = true,
  gl,
  connectome = null,
  dpg = null,
  dps = null,
  dpv = null
) {
  this.name = name;
  this.id = uuidv4();
  let obj = getExtents(pts);
  this.furthestVertexFromOrigin = obj.mxDx;
  this.extentsMin = obj.extentsMin;
  this.extentsMax = obj.extentsMax;
  this.opacity = opacity > 1.0 ? 1.0 : opacity; //make sure opacity can't be initialized greater than 1 see: #107 and #117 on github
  this.visible = visible;
  this.indexBuffer = gl.createBuffer();
  this.vertexBuffer = gl.createBuffer();
  this.vao = gl.createVertexArray();
  this.offsetPt0 = null;
  this.hasConnectome = false;
  this.pts = pts;
  this.layers = [];
  if (!rgba255) {
    this.fiberLength = 2;
    this.fiberDither = 0.1;
    this.fiberColor = "Global";
    this.fiberDecimationStride = 1; //e.g. if 2 the 50% of streamlines visible, if 3 then 1/3rd
    this.fiberMask = []; //provide method to show/hide specific fibers
    this.colormap = connectome;
    this.dpg = dpg;
    this.dps = dps;
    this.dpv = dpv;
    this.offsetPt0 = tris;
    this.updateFibers(gl);
    //define VAO
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    //vertex position: 3 floats X,Y,Z
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
    //vertex color
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 16, 12);
    gl.bindVertexArray(null); // https://stackoverflow.com/questions/43904396/are-we-not-allowed-to-bind-gl-array-buffer-and-vertex-attrib-array-to-0-in-webgl
    return;
  } //if fiber not mesh
  if (connectome) {
    this.hasConnectome = true;
    var keysArray = Object.keys(connectome);
    for (var i = 0, len = keysArray.length; i < len; i++) {
      this[keysArray[i]] = connectome[keysArray[i]];
    }
  }
  this.rgba255 = rgba255;
  this.tris = tris;
  this.updateMesh(gl);
  //the VAO binds the vertices and indices as well as describing the vertex layout
  gl.bindVertexArray(this.vao);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
  gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
  //vertex position: 3 floats X,Y,Z
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
  //vertex surface normal vector: (also three floats)
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
  //vertex color
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 28, 24);
  gl.bindVertexArray(null); // https://stackoverflow.com/questions/43904396/are-we-not-allowed-to-bind-gl-array-buffer-and-vertex-attrib-array-to-0-in-webgl
}

NVMesh.prototype.updateFibers = function (gl) {
  if (!this.offsetPt0 || !this.fiberLength) return;
  //VERTICES:
  let pts = this.pts;
  let offsetPt0 = this.offsetPt0;
  let n_count = offsetPt0.length - 1;
  let npt = pts.length / 3; //each point has three components: X,Y,Z
  //only once: compute length of each streamline
  if (!this.fiberLengths) {
    this.fiberLengths = [];
    for (let i = 0; i < n_count; i++) {
      //for each streamline
      let vStart3 = offsetPt0[i] * 3; //first vertex in streamline
      let vEnd3 = (offsetPt0[i + 1] - 1) * 3; //last vertex in streamline
      let len = 0;
      for (let j = vStart3; j < vEnd3; j += 3) {
        let v = vec3.fromValues(
          pts[j + 0] - pts[j + 3],
          pts[j + 1] - pts[j + 4],
          pts[j + 2] - pts[j + 5]
        );
        len += vec3.len(v);
      }
      this.fiberLengths.push(len);
    }
  } //only once: compute length of each streamline
  //determine fiber colors
  //Each streamline vertex has color and position attributes
  //Interleaved Vertex Data https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/OpenGLES_ProgrammingGuide/TechniquesforWorkingwithVertexData/TechniquesforWorkingwithVertexData.html
  var posClrF32 = new Float32Array(npt * 4); //four 32-bit components X,Y,Z,C
  var posClrU32 = new Uint32Array(posClrF32.buffer); //typecast of our X,Y,Z,C array
  //fill XYZ position of XYZC array
  let i3 = 0;
  let i4 = 0;
  for (let i = 0; i < npt; i++) {
    posClrF32[i4 + 0] = pts[i3 + 0];
    posClrF32[i4 + 1] = pts[i3 + 1];
    posClrF32[i4 + 2] = pts[i3 + 2];
    i3 += 3;
    i4 += 4;
  }
  //fill fiber Color
  let dither = this.fiberDither;
  let ditherHalf = dither * 0.5;
  function direction2rgb(x1, y1, z1, x2, y2, z2, ditherFrac) {
    //generate color based on direction between two 3D spatial positions
    let v = vec3.fromValues(
      Math.abs(x1 - x2),
      Math.abs(y1 - y2),
      Math.abs(z1 - z2)
    );
    vec3.normalize(v, v);
    let r = ditherFrac - ditherHalf;
    for (let j = 0; j < 3; j++)
      v[j] = 255 * Math.max(Math.min(Math.abs(v[j]) + r, 1.0), 0.0);
    return v[0] + (v[1] << 8) + (v[2] << 16);
  } // direction2rgb()
  //Determine color: local, global, dps0, dpv0, etc.
  let fiberColor = this.fiberColor.toLowerCase();
  let dps = null;
  let dpv = null;
  if (fiberColor.startsWith("dps") && this.dps.length > 0) {
    let n = parseInt(fiberColor.substring(3));
    if (n < this.dps.length && this.dps[n].vals.length === n_count)
      dps = this.dps[n].vals;
  }
  if (fiberColor.startsWith("dpv") && this.dpv.length > 0) {
    let n = parseInt(fiberColor.substring(3));
    if (n < this.dpv.length && this.dpv[n].vals.length === npt)
      dpv = this.dpv[n].vals;
  }
  if (dpv) {
    //color per streamline
    let lut = cmapper.colormap(this.colormap);
    let mn = dpv[0];
    let mx = dpv[0];
    for (let i = 0; i < npt; i++) {
      mn = Math.min(mn, dpv[i]);
      mx = Math.max(mx, dpv[i]);
    }
    let v4 = 3; //+3: fill 4th component colors: XYZC = 0123
    for (let i = 0; i < npt; i++) {
      let color = (dpv[i] - mn) / (mx - mn);
      color = Math.round(Math.max(Math.min(255, color * 255)), 1) * 4;
      let RGBA = lut[color] + (lut[color + 1] << 8) + (lut[color + 2] << 16);
      posClrU32[v4] = RGBA;
      v4 += 4;
    }
  } else if (dps) {
    //color per streamline
    let lut = cmapper.colormap(this.colormap);
    let mn = dps[0];
    let mx = dps[0];
    for (let i = 0; i < n_count; i++) {
      mn = Math.min(mn, dps[i]);
      mx = Math.max(mx, dps[i]);
    }
    if (mx === mn) mn -= 1; //avoid divide by zero
    for (let i = 0; i < n_count; i++) {
      let color = (dps[i] - mn) / (mx - mn);
      color = Math.round(Math.max(Math.min(255, color * 255)), 1) * 4;
      let RGBA = lut[color] + (lut[color + 1] << 8) + (lut[color + 2] << 16);
      let vStart = offsetPt0[i]; //first vertex in streamline
      let vEnd = offsetPt0[i + 1] - 1; //last vertex in streamline
      let vStart4 = vStart * 4 + 3; //+3: fill 4th component colors: XYZC = 0123
      let vEnd4 = vEnd * 4 + 3;
      for (let j = vStart4; j <= vEnd4; j += 4) posClrU32[j] = RGBA;
    }
  } else if (fiberColor.includes("local")) {
    for (let i = 0; i < n_count; i++) {
      //for each streamline
      let vStart = offsetPt0[i]; //first vertex in streamline
      let vEnd = offsetPt0[i + 1] - 1; //last vertex in streamline
      let v3 = vStart * 3; //pts have 3 components XYZ
      let vEnd3 = vEnd * 3;
      let ditherFrac = dither * Math.random(); //same dither amount throughout line
      //for first point, we do not have a prior sample
      let RGBA = direction2rgb(
        pts[v3],
        pts[v3 + 1],
        pts[v3 + 2],
        pts[v3 + 4],
        pts[v3 + 5],
        pts[v3 + 6],
        ditherFrac
      );
      let v4 = vStart * 4 + 3; //+3: fill 4th component colors: XYZC = 0123
      while (v3 < vEnd3) {
        posClrU32[v4] = RGBA;
        v4 += 4; //stride is 4 32-bit values: float32 XYZ and 32-bit rgba
        v3 += 3; //read next vertex
        //direction estimated based on previous and next vertex
        RGBA = direction2rgb(
          pts[v3 - 3],
          pts[v3 - 2],
          pts[v3 - 1],
          pts[v3 + 3],
          pts[v3 + 4],
          pts[v3 + 5],
          ditherFrac
        );
      }
      posClrU32[v4] = posClrU32[v4 - 4];
    }
  } else {
    //if color is local direction, else global
    for (let i = 0; i < n_count; i++) {
      //for each streamline
      let vStart = offsetPt0[i]; //first vertex in streamline
      let vEnd = offsetPt0[i + 1] - 1; //last vertex in streamline
      let vStart3 = vStart * 3; //pts have 3 components XYZ
      let vEnd3 = vEnd * 3;
      let RGBA = direction2rgb(
        pts[vStart3],
        pts[vStart3 + 1],
        pts[vStart3 + 2],
        pts[vEnd3],
        pts[vEnd3 + 1],
        pts[vEnd3 + 2],
        dither * Math.random()
      );
      let vStart4 = vStart * 4 + 3; //+3: fill 4th component colors: XYZC = 0123
      let vEnd4 = vEnd * 4 + 3;
      for (let j = vStart4; j <= vEnd4; j += 4) posClrU32[j] = RGBA;
    }
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Uint32Array(posClrU32), gl.STATIC_DRAW);
  //INDICES:
  let min_mm = this.fiberLength;
  //  https://blog.spacepatroldelta.com/a?ID=00950-d878555f-a97a-4e32-9f40-fd9a449cb4fe
  let primitiveRestart = Math.pow(2, 32) - 1; //for gl.UNSIGNED_INT
  let indices = [];
  let stride = -1;
  for (let i = 0; i < n_count; i++) {
    //let n_pts = offsetPt0[i + 1] - offsetPt0[i]; //if streamline0 starts at point 0 and streamline1 at point 4, then streamline0 has 4 points: 0,1,2,3
    if (this.fiberLengths[i] < min_mm) continue;
    stride++;
    if (stride % this.fiberDecimationStride !== 0) continue; //e.g. if stride is 2 then half culled
    for (let j = offsetPt0[i]; j < offsetPt0[i + 1]; j++) indices.push(j);
    indices.push(primitiveRestart);
  }
  this.indexCount = indices.length;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
  //glBufferData creates a new data store for the buffer object currently bound to target​. Any pre-existing data store is deleted.
  gl.bufferData(
    gl.ELEMENT_ARRAY_BUFFER,
    new Uint32Array(indices),
    gl.STATIC_DRAW
  );
};

NVMesh.prototype.updateConnectome = function (gl) {
  //draw nodes
  let json = this;
  //draw nodes
  let tris = [];
  let nNode = json.nodes.X.length;
  let hasEdges = false;
  if (nNode > 1 && json.hasOwnProperty("edges")) {
    let nEdges = json.edges.length;
    if ((nEdges = nNode * nNode)) hasEdges = true;
    else console.log("Expected %d edges not %d", nNode * nNode, nEdges);
  }
  //draw all nodes
  let pts = [];
  let rgba255 = [];
  let lut = cmapper.colormap(json.nodeColormap);
  let lutNeg = cmapper.colormap(json.nodeColormapNegative);
  let hasNeg = json.hasOwnProperty("nodeColormapNegative");
  let min = json.nodeMinColor;
  let max = json.nodeMaxColor;
  for (let i = 0; i < nNode; i++) {
    let radius = json.nodes.Size[i] * json.nodeScale;
    if (radius <= 0.0) continue;
    let color = json.nodes.Color[i];
    let isNeg = false;
    if (hasNeg && color < 0) {
      isNeg = true;
      color = -color;
    }
    if (min < max) {
      if (color < min) continue;
      color = (color - min) / (max - min);
    } else color = 1.0;
    color = Math.round(Math.max(Math.min(255, color * 255)), 1) * 4;
    let rgba = [lut[color], lut[color + 1], lut[color + 2], 255];
    if (isNeg)
      rgba = [lutNeg[color], lutNeg[color + 1], lutNeg[color + 2], 255];
    let pt = [json.nodes.X[i], json.nodes.Y[i], json.nodes.Z[i]];
    NiivueObject3D.makeColoredSphere(pts, tris, rgba255, radius, pt, rgba);
  }
  //draw all edges
  if (hasEdges) {
    lut = cmapper.colormap(json.edgeColormap);
    lutNeg = cmapper.colormap(json.edgeColormapNegative);
    hasNeg = json.hasOwnProperty("edgeColormapNegative");
    min = json.edgeMin;
    max = json.edgeMax;
    for (let i = 0; i < nNode - 1; i++) {
      for (let j = i + 1; j < nNode; j++) {
        let color = json.edges[i * nNode + j];
        let isNeg = false;
        if (hasNeg && color < 0) {
          isNeg = true;
          color = -color;
        }
        let radius = color * json.edgeScale;
        if (radius <= 0) continue;
        if (min < max) {
          if (color < min) continue;
          color = (color - min) / (max - min);
        } else color = 1.0;
        color = Math.round(Math.max(Math.min(255, color * 255)), 1) * 4;
        let rgba = [lut[color], lut[color + 1], lut[color + 2], 255];
        if (isNeg)
          rgba = [lutNeg[color], lutNeg[color + 1], lutNeg[color + 2], 255];

        let pti = [json.nodes.X[i], json.nodes.Y[i], json.nodes.Z[i]];
        let ptj = [json.nodes.X[j], json.nodes.Y[j], json.nodes.Z[j]];
        NiivueObject3D.makeColoredCylinder(
          pts,
          tris,
          rgba255,
          pti,
          ptj,
          radius,
          rgba
        );
      } //for j
    } //for i
  } //hasEdges
  //calculate spatial extent of connectome: user adjusting node sizes may influence size
  let obj = getExtents(pts);
  this.furthestVertexFromOrigin = obj.mxDx;
  this.extentsMin = obj.extentsMin;
  this.extentsMax = obj.extentsMax;
  let posNormClr = this.generatePosNormClr(pts, tris, rgba255);
  //generate webGL buffers and vao
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Int32Array(tris), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(posNormClr), gl.STATIC_DRAW);
  this.indexCount = tris.length;
};

NVMesh.prototype.updateMesh = function (gl) {
  if (this.offsetPt0) {
    this.updateFibers(gl);
    return; //fiber not mesh
  }
  if (this.hasConnectome) {
    this.updateConnectome(gl);
    return; //connectome not mesh
  }
  if (!this.pts || !this.tris || !this.rgba255) {
    console.log("underspecified mesh");
    return;
  }
  let posNormClr = this.generatePosNormClr(this.pts, this.tris, this.rgba255);
  if (this.layers && this.layers.length > 0) {
    for (let i = 0; i < this.layers.length; i++) {
      let layer = this.layers[i];
      if (layer.opacity <= 0.0 || layer.cal_min >= layer.cal_max) continue;
      let opacity = layer.opacity;
      var u8 = new Uint8Array(posNormClr.buffer); //Each vertex has 7 components: PositionXYZ, NormalXYZ, RGBA32
      function lerp(x, y, a) {
        //https://www.khronos.org/registry/OpenGL-Refpages/gl4/html/mix.xhtml
        return x * (1 - a) + y * a;
      }
      if (layer.values.constructor === Uint32Array) {
        //isRGBA!
        let rgba8 = new Uint8Array(layer.values.buffer);
        let k = 0;
        for (let j = 0; j < layer.values.length; j++) {
          let vtx = j * 28 + 24; //posNormClr is 28 bytes stride, RGBA color at offset 24,
          u8[vtx + 0] = lerp(u8[vtx + 0], rgba8[k + 0], opacity);
          u8[vtx + 1] = lerp(u8[vtx + 1], rgba8[k + 1], opacity);
          u8[vtx + 2] = lerp(u8[vtx + 2], rgba8[k + 2], opacity);
          k += 4;
        }
        continue;
      }
      let lut = cmapper.colormap(layer.colorMap);

      let frame = Math.min(Math.max(layer.frame4D, 0), layer.nFrame4D - 1);
      let nvtx = this.pts.length / 3;
      let frameOffset = nvtx * frame;
      if (layer.useNegativeCmap) {
        layer.cal_min = Math.max(0, layer.cal_min);
        layer.cal_max = Math.max(layer.cal_min + 0.000001, layer.cal_max);
      }
      let scale255 = 255.0 / (layer.cal_max - layer.cal_min);
      //blend colors for each voxel
      for (let j = 0; j < nvtx; j++) {
        let v255 = Math.round(
          (layer.values[j + frameOffset] - layer.cal_min) * scale255
        );
        if (v255 < 0) continue;
        v255 = Math.min(255.0, v255) * 4;
        let vtx = j * 28 + 24; //posNormClr is 28 bytes stride, RGBA color at offset 24,
        u8[vtx + 0] = lerp(u8[vtx + 0], lut[v255 + 0], opacity);
        u8[vtx + 1] = lerp(u8[vtx + 1], lut[v255 + 1], opacity);
        u8[vtx + 2] = lerp(u8[vtx + 2], lut[v255 + 2], opacity);
      }
      if (layer.useNegativeCmap) {
        let lut = cmapper.colormap(layer.colorMapNegative);
        for (let j = 0; j < nvtx; j++) {
          let v255 = Math.round(
            (-layer.values[j + frameOffset] - layer.cal_min) * scale255
          );
          if (v255 < 0) continue;
          v255 = Math.min(255.0, v255) * 4;
          let vtx = j * 28 + 24; //posNormClr is 28 bytes stride, RGBA color at offset 24,
          u8[vtx + 0] = lerp(u8[vtx + 0], lut[v255 + 0], opacity);
          u8[vtx + 1] = lerp(u8[vtx + 1], lut[v255 + 1], opacity);
          u8[vtx + 2] = lerp(u8[vtx + 2], lut[v255 + 2], opacity);
        }
      }
    }
  }
  //generate webGL buffers and vao
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
  gl.bufferData(
    gl.ELEMENT_ARRAY_BUFFER,
    new Int32Array(this.tris),
    gl.STATIC_DRAW
  );
  gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(posNormClr), gl.STATIC_DRAW);
  this.indexCount = this.tris.length;
  this.vertexCount = this.pts.length;
};

NVMesh.prototype.setLayerProperty = function (id, key, val, gl) {
  let layer = this.layers[id];
  if (!layer.hasOwnProperty(key)) {
    console.log("mesh does not have property ", key, layer);
    return;
  }
  layer[key] = val;
  this.updateMesh(gl); //apply the new properties...
};
NVMesh.prototype.setProperty = function (key, val, gl) {
  if (!this.hasOwnProperty(key)) {
    console.log("mesh does not have property ", key, this);
    return;
  }
  this[key] = val;
  this.updateMesh(gl); //apply the new properties...
};

function getExtents(pts) {
  //each vertex has 3 coordinates: XYZ
  let mxDx = 0.0;
  let mn = vec3.fromValues(pts[0], pts[1], pts[2]);
  let mx = vec3.fromValues(pts[0], pts[1], pts[2]);
  for (let i = 0; i < pts.length; i += 3) {
    let v = vec3.fromValues(pts[i], pts[i + 1], pts[i + 2]);
    mxDx = Math.max(mxDx, vec3.len(v));
    vec3.min(mn, mn, v);
    vec3.max(mx, mx, v);
  }
  let extentsMin = [mn[0], mn[1], mn[2]];
  let extentsMax = [mx[0], mx[1], mx[2]];
  return { mxDx, extentsMin, extentsMax };
}

function generateNormals(pts, tris) {
  //from https://github.com/rii-mango/Papaya
  /*
Copyright (c) 2012-2015, RII-UTHSCSA
All rights reserved.

THIS PRODUCT IS NOT FOR CLINICAL USE.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

 - Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.

 - Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.

 - Neither the name of the RII-UTHSCSA nor the names of its contributors may be used to endorse or promote products
   derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
 INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
  var p1 = [],
    p2 = [],
    p3 = [],
    normal = [],
    nn = [],
    ctr,
    normalsDataLength = pts.length,
    numIndices,
    qx,
    qy,
    qz,
    px,
    py,
    pz,
    index1,
    index2,
    index3;

  let norms = new Float32Array(normalsDataLength);
  numIndices = tris.length;
  for (ctr = 0; ctr < numIndices; ctr += 3) {
    index1 = tris[ctr] * 3;
    index2 = tris[ctr + 1] * 3;
    index3 = tris[ctr + 2] * 3;

    p1.x = pts[index1];
    p1.y = pts[index1 + 1];
    p1.z = pts[index1 + 2];

    p2.x = pts[index2];
    p2.y = pts[index2 + 1];
    p2.z = pts[index2 + 2];

    p3.x = pts[index3];
    p3.y = pts[index3 + 1];
    p3.z = pts[index3 + 2];

    qx = p2.x - p1.x;
    qy = p2.y - p1.y;
    qz = p2.z - p1.z;
    px = p3.x - p1.x;
    py = p3.y - p1.y;
    pz = p3.z - p1.z;

    normal[0] = py * qz - pz * qy;
    normal[1] = pz * qx - px * qz;
    normal[2] = px * qy - py * qx;

    norms[index1] += normal[0];
    norms[index1 + 1] += normal[1];
    norms[index1 + 2] += normal[2];

    norms[index2] += normal[0];
    norms[index2 + 1] += normal[1];
    norms[index2 + 2] += normal[2];

    norms[index3] += normal[0];
    norms[index3 + 1] += normal[1];
    norms[index3 + 2] += normal[2];
  }
  for (ctr = 0; ctr < normalsDataLength; ctr += 3) {
    normal[0] = -1 * norms[ctr];
    normal[1] = -1 * norms[ctr + 1];
    normal[2] = -1 * norms[ctr + 2];
    let len =
      normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2];
    if (len > 0) {
      len = 1.0 / Math.sqrt(len);
      normal[0] *= len;
      normal[1] *= len;
      normal[2] *= len;
    }
    norms[ctr] = normal[0];
    norms[ctr + 1] = normal[1];
    norms[ctr + 2] = normal[2];
  }
  return norms;
}

NVMesh.prototype.generatePosNormClr = function (pts, tris, rgba255) {
  //Each streamline vertex has color, normal and position attributes
  //Interleaved Vertex Data https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/OpenGLES_ProgrammingGuide/TechniquesforWorkingwithVertexData/TechniquesforWorkingwithVertexData.html
  if (pts.length < 3 || rgba255.length < 4)
    log.error("Catastrophic failure generatePosNormClr()");
  let norms = generateNormals(pts, tris);
  let npt = pts.length / 3;
  let isPerVertexColors = npt === rgba255.length / 4;
  var f32 = new Float32Array(npt * 7); //Each vertex has 7 components: PositionXYZ, NormalXYZ, RGBA32
  var u8 = new Uint8Array(f32.buffer); //Each vertex has 7 components: PositionXYZ, NormalXYZ, RGBA32
  let p = 0; //input position
  let c = 0; //input color
  let f = 0; //output float32 location (position and normals)
  let u = 24; //output uint8 location (colors), offset 24 as after 3*position+3*normal
  for (let i = 0; i < npt; i++) {
    f32[f + 0] = pts[p + 0];
    f32[f + 1] = pts[p + 1];
    f32[f + 2] = pts[p + 2];
    f32[f + 3] = norms[p + 0];
    f32[f + 4] = norms[p + 1];
    f32[f + 5] = norms[p + 2];
    u8[u] = rgba255[c + 0];
    u8[u + 1] = rgba255[c + 1];
    u8[u + 2] = rgba255[c + 2];
    u8[u + 3] = rgba255[c + 3];
    if (isPerVertexColors) c += 4;
    p += 3; //read 3 input components: XYZ
    f += 7; //write 7 output components: 3*Position, 3*Normal, 1*RGBA
    u += 28; //stride of 28 bytes
  }
  return f32;
};

NVMesh.readTCK = function (buffer) {
  //https://mrtrix.readthedocs.io/en/latest/getting_started/image_data.html#tracks-file-format-tck
  let len = buffer.byteLength;
  if (len < 20) throw new Error("File too small to be TCK: bytes = " + len);
  var bytes = new Uint8Array(buffer);
  let pos = 0;
  function readStr() {
    while (pos < len && bytes[pos] === 10) pos++; //skip blank lines
    let startPos = pos;
    while (pos < len && bytes[pos] !== 10) pos++;
    pos++; //skip EOLN
    if (pos - startPos < 1) return "";
    return new TextDecoder().decode(buffer.slice(startPos, pos - 1));
  }
  let line = readStr(); //1st line: signature 'mrtrix tracks'
  if (!line.includes("mrtrix tracks")) {
    console.log("Not a valid TCK file");
    return;
  }
  while (pos < len && !line.startsWith("END")) line = readStr();
  var reader = new DataView(buffer);
  //read and transform vertex positions
  let npt = 0;
  let offsetPt0 = [];
  offsetPt0.push(npt); //1st streamline starts at 0
  let pts = [];
  while (pos + 12 < len) {
    var ptx = reader.getFloat32(pos, true);
    pos += 4;
    var pty = reader.getFloat32(pos, true);
    pos += 4;
    var ptz = reader.getFloat32(pos, true);
    pos += 4;
    if (!isFinite(ptx)) {
      //both NaN and Inifinity are not finite
      offsetPt0.push(npt);
      if (!isNaN(ptx))
        //terminate if infinity
        break;
    } else {
      pts.push(ptx);
      pts.push(pty);
      pts.push(ptz);
      npt++;
    }
  }
  return {
    pts,
    offsetPt0,
  };
}; //readTCK()

NVMesh.readTRK = function (buffer) {
  // http://trackvis.org/docs/?subsect=fileformat
  // http://www.tractometer.org/fiberweb/
  // https://github.com/xtk/X/tree/master/io
  // in practice, always little endian
  var reader = new DataView(buffer);
  var magic = reader.getUint32(0, true); //'TRAC'
  if (magic !== 1128354388) {
    //e.g. TRK.gz
    let raw;
    if (magic === 4247762216) {
      //zstd
      raw = fzstd.decompress(new Uint8Array(buffer));
      raw = new Uint8Array(raw);
    } else raw = fflate.decompressSync(new Uint8Array(buffer));
    buffer = raw.buffer;
    reader = new DataView(buffer);
    magic = reader.getUint32(0, true); //'TRAC'
  }
  var vers = reader.getUint32(992, true); //2
  var hdr_sz = reader.getUint32(996, true); //1000
  if (vers > 2 || hdr_sz !== 1000 || magic !== 1128354388)
    throw new Error("Not a valid TRK file");
  let dps = [];
  let dpv = [];
  var n_scalars = reader.getInt16(36, true);
  if (n_scalars > 0) {
    //data_per_vertex
    for (let i = 0; i < n_scalars; i++) {
      let arr = new Uint8Array(buffer.slice(38 + i * 20, 58 + i * 20));
      var str = new TextDecoder().decode(arr).split("\0").shift();
      dpv.push({
        id: str.trim(),
        vals: [],
      });
    }
  }
  var voxel_sizeX = reader.getFloat32(12, true);
  var voxel_sizeY = reader.getFloat32(16, true);
  var voxel_sizeZ = reader.getFloat32(20, true);
  var zoomMat = mat4.fromValues(
    1 / voxel_sizeX,
    0,
    0,
    -0.5,
    0,
    1 / voxel_sizeY,
    0,
    -0.5,
    0,
    0,
    1 / voxel_sizeZ,
    -0.5,
    0,
    0,
    0,
    1
  );
  var n_properties = reader.getInt16(238, true);
  if (n_properties > 0) {
    for (let i = 0; i < n_properties; i++) {
      let arr = new Uint8Array(buffer.slice(240 + i * 20, 260 + i * 20));
      var str = new TextDecoder().decode(arr).split("\0").shift();
      dps.push({
        id: str.trim(),
        vals: [],
      });
    }
  }
  var mat = mat4.create();
  for (let i = 0; i < 16; i++) mat[i] = reader.getFloat32(440 + i * 4, true);
  if (mat[15] === 0.0) {
    //vox_to_ras[3][3] is 0, it means the matrix is not recorded
    console.log("TRK vox_to_ras not set");
    mat4.identity(mat);
  }
  var vox2mmMat = mat4.create();
  mat4.mul(vox2mmMat, mat, zoomMat);
  let i32 = null;
  let f32 = null;
  i32 = new Int32Array(buffer.slice(hdr_sz));
  f32 = new Float32Array(i32.buffer);

  let ntracks = i32.length;
  //read and transform vertex positions
  let i = 0;
  let npt = 0;
  let offsetPt0 = [];
  let pts = [];
  while (i < ntracks) {
    let n_pts = i32[i];
    i = i + 1; // read 1 32-bit integer for number of points in this streamline
    offsetPt0.push(npt); //index of first vertex in this streamline
    for (let j = 0; j < n_pts; j++) {
      let ptx = f32[i + 0];
      let pty = f32[i + 1];
      let ptz = f32[i + 2];
      i += 3; //read 3 32-bit floats for XYZ position
      pts.push(
        ptx * vox2mmMat[0] +
          pty * vox2mmMat[1] +
          ptz * vox2mmMat[2] +
          vox2mmMat[3]
      );
      pts.push(
        ptx * vox2mmMat[4] +
          pty * vox2mmMat[5] +
          ptz * vox2mmMat[6] +
          vox2mmMat[7]
      );
      pts.push(
        ptx * vox2mmMat[8] +
          pty * vox2mmMat[9] +
          ptz * vox2mmMat[10] +
          vox2mmMat[11]
      );
      if (n_scalars > 0) {
        for (let s = 0; s < n_scalars; s++) {
          dpv[s].vals.push(f32[i]);
          i++;
        }
      }
      npt++;
    } // for j: each point in streamline
    if (n_properties > 0) {
      for (let j = 0; j < n_properties; j++) {
        dps[j].vals.push(f32[i]);
        i++;
      }
    }
  } //for each streamline: while i < n_count
  offsetPt0.push(npt); //add 'first index' as if one more line was added (fence post problem)
  return {
    pts,
    offsetPt0,
    dps,
    dpv,
  };
}; //readTRK()

function readTxtVTK(buffer) {
  var enc = new TextDecoder("utf-8");
  var txt = enc.decode(buffer);
  var lines = txt.split("\n");
  var n = lines.length;
  if (n < 7 || !lines[0].startsWith("# vtk DataFile"))
    alert("Invalid VTK image");
  if (!lines[2].startsWith("ASCII")) alert("Not ASCII VTK mesh");
  let pos = 3;
  while (lines[pos].length < 1) pos++; //skip blank lines
  if (!lines[pos].includes("POLYDATA")) alert("Not ASCII VTK polydata");
  pos++;
  while (lines[pos].length < 1) pos++; //skip blank lines
  if (!lines[pos].startsWith("POINTS")) alert("Not VTK POINTS");
  let items = lines[pos].split(" ");
  let nvert = parseInt(items[1]); //POINTS 10261 float
  let nvert3 = nvert * 3;
  var positions = new Float32Array(nvert * 3);
  let v = 0;
  while (v < nvert * 3) {
    pos++;
    let str = lines[pos].trim();
    let pts = str.split(" ");
    for (let i = 0; i < pts.length; i++) {
      if (v >= nvert3) break;
      positions[v] = parseFloat(pts[i]);
      v++;
    }
  }
  let tris = [];
  pos++;
  while (lines[pos].length < 1) pos++; //skip blank lines
  items = lines[pos].split(" ");
  pos++;
  if (items[0].includes("LINES")) {
    let n_count = parseInt(items[1]);
    if (n_count < 1) alert("Corrupted VTK ASCII");
    let str = lines[pos].trim();
    let offsetPt0 = [];
    let pts = [];
    if (str.startsWith("OFFSETS")) {
      // 'new' line style https://discourse.vtk.org/t/upcoming-changes-to-vtkcellarray/2066
      offsetPt0 = new Uint32Array(n_count);
      pos++;
      let c = 0;
      while (c < n_count) {
        str = lines[pos].trim();
        pos++;
        let items = str.split(" ");
        for (let i = 0; i < items.length; i++) {
          offsetPt0[c] = parseInt(items[i]);
          c++;
          if (c >= n_count) break;
        } //for each line
      } //while offset array not filled
      pts = positions;
    } else {
      //classic line style https://www.visitusers.org/index.php?title=ASCII_VTK_Files
      offsetPt0 = new Uint32Array(n_count + 1);
      let npt = 0;
      pts = [];
      offsetPt0[0] = 0; //1st streamline starts at 0
      let asciiInts = [];
      let asciiIntsPos = 0;
      function lineToInts() {
        //VTK can save one array across multiple ASCII lines
        str = lines[pos].trim();
        let items = str.split(" ");
        asciiInts = [];
        for (let i = 0; i < items.length; i++)
          asciiInts.push(parseInt(items[i]));
        asciiIntsPos = 0;
        pos++;
      }
      lineToInts();
      for (let c = 0; c < n_count; c++) {
        if (asciiIntsPos >= asciiInts.length) lineToInts();
        let numPoints = asciiInts[asciiIntsPos++];
        npt += numPoints;
        offsetPt0[c + 1] = npt;
        for (let i = 0; i < numPoints; i++) {
          if (asciiIntsPos >= asciiInts.length) lineToInts();
          let idx = asciiInts[asciiIntsPos++] * 3;
          pts.push(positions[idx + 0]); //X
          pts.push(positions[idx + 1]); //Y
          pts.push(positions[idx + 2]); //Z
        } //for numPoints: number of segments in streamline
      } //for n_count: number of streamlines
    }
    return {
      pts,
      offsetPt0,
    };
  } else if (items[0].includes("TRIANGLE_STRIPS")) {
    let nstrip = parseInt(items[1]);
    for (let i = 0; i < nstrip; i++) {
      let str = lines[pos].trim();
      pos++;
      let vs = str.split(" ");
      let ntri = parseInt(vs[0]) - 2; //-2 as triangle strip is creates pts - 2 faces
      let k = 1;
      for (let t = 0; t < ntri; t++) {
        if (t % 2) {
          // preserve winding order
          tris.push(parseInt(vs[k + 2]));
          tris.push(parseInt(vs[k + 1]));
          tris.push(parseInt(vs[k]));
        } else {
          tris.push(parseInt(vs[k]));
          tris.push(parseInt(vs[k + 1]));
          tris.push(parseInt(vs[k + 2]));
        }
        k += 1;
      } //for each triangle
    } //for each strip
  } else if (items[0].includes("POLYGONS")) {
    let npoly = parseInt(items[1]);
    for (let i = 0; i < npoly; i++) {
      let str = lines[pos].trim();
      pos++;
      let vs = str.split(" ");
      let ntri = parseInt(vs[0]) - 2; //e.g. 3 for triangle
      let fx = parseInt(vs[1]);
      let fy = parseInt(vs[2]);
      for (let t = 0; t < ntri; t++) {
        let fz = parseInt(vs[3 + t]);
        tris.push(fx);
        tris.push(fy);
        tris.push(fz);
        fy = fz;
      }
    }
  } else alert("Unsupported ASCII VTK datatype " + items[0]);
  var indices = new Int32Array(tris);
  return {
    positions,
    indices,
  };
} // readTxtVTK()

NVMesh.readSTC = function (buffer, n_vert) {
  //mne STC format
  //https://github.com/mne-tools/mne-python/blob/main/mne/source_estimate.py#L211-L365
  //https://github.com/fahsuanlin/fhlin_toolbox/blob/400cb73cda4880d9ad7841d9dd68e4e9762976bf/codes/inverse_read_stc.m
  let len = buffer.byteLength;
  var reader = new DataView(buffer);
  //first 12 bytes are header
  let epoch_begin_latency = reader.getFloat32(0, false);
  let sample_period = reader.getFloat32(4, false);
  let n_vertex = reader.getInt32(8, false);
  if (n_vertex !== n_vert) {
    console.log("Overlay has " + n_vertex + " vertices, expected " + n_vert);
    return;
  }
  //next 4*n_vertex bytes are vertex IDS
  let pos = 12 + n_vertex * 4;
  //next 4 bytes reports number of volumes/time points
  let n_time = reader.getUint32(pos, false);
  pos += 4;
  let f32 = new Float32Array(n_time * n_vertex);
  //reading all floats with .slice() would be faster, but lets handle endian-ness
  for (let i = 0; i < n_time * n_vertex; i++) {
    f32[i] = reader.getFloat32(pos, false);
    pos += 4;
  }
  return f32;
  //this.vertexCount = this.pts.length;
}; // readSTC()

NVMesh.readCURV = function (buffer, n_vert) {
  //simple format used by Freesurfer  BIG-ENDIAN
  // https://github.com/bonilhamusclab/MRIcroS/blob/master/%2BfileUtils/%2Bpial/readPial.m
  // http://www.grahamwideman.com/gw/brain/fs/surfacefileformats.htm
  const view = new DataView(buffer); //ArrayBuffer to dataview
  //ALWAYS big endian
  let sig0 = view.getUint8(0);
  let sig1 = view.getUint8(1);
  let sig2 = view.getUint8(2);
  let n_vertex = view.getUint32(3, false);
  let num_f = view.getUint32(7, false);
  let n_time = view.getUint32(11, false);
  if (sig0 !== 255 || sig1 !== 255 || sig2 !== 255)
    log.debug(
      "Unable to recognize file type: does not appear to be FreeSurfer format."
    );
  if (n_vert !== n_vertex) {
    console.log("CURV file has different number of vertices than mesh");
    return;
  }
  if (buffer.byteLength < 15 + 4 * n_vertex * n_time) {
    console.log("CURV file smaller than specified");
    return;
  }
  let f32 = new Float32Array(n_time * n_vertex);
  let pos = 15;
  //reading all floats with .slice() would be faster, but lets handle endian-ness
  for (let i = 0; i < n_time * n_vertex; i++) {
    f32[i] = view.getFloat32(pos, false);
    pos += 4;
  }
  let mn = f32[0];
  let mx = f32[0];
  for (var i = 0; i < f32.length; i++) {
    mn = Math.min(mn, f32[i]);
    mx = Math.max(mx, f32[i]);
  }
  //normalize and invert then sqrt
  let scale = 1.0 / (mx - mn);
  for (var i = 0; i < f32.length; i++)
    f32[i] = Math.sqrt(1.0 - (f32[i] - mn) * scale);
  return f32;
}; // readCURV()

NVMesh.readANNOT = function (buffer, n_vert) {
  //freesurfer Annotation file provides vertex colors
  //  https://surfer.nmr.mgh.harvard.edu/fswiki/LabelsClutsAnnotationFiles
  const view = new DataView(buffer); //ArrayBuffer to dataview
  //ALWAYS big endian
  let n_vertex = view.getUint32(0, false);
  if (n_vert !== n_vertex) {
    console.log("ANNOT file has different number of vertices than mesh");
    return;
  }
  if (buffer.byteLength < 4 + 8 * n_vertex) {
    console.log("ANNOT file smaller than specified");
    return;
  }
  let pos = 4;
  //reading all floats with .slice() would be faster, but lets handle endian-ness
  let rgba32 = new Uint32Array(n_vertex);
  for (let i = 0; i < n_vertex; i++) {
    let idx = view.getUint32(pos, false);
    pos += 4;
    rgba32[idx] = view.getUint32(pos, false);
    pos += 4;
  }
  return rgba32;
}; // readANNOT()

NVMesh.readVTK = function (buffer) {
  let len = buffer.byteLength;
  if (len < 20)
    throw new Error("File too small to be VTK: bytes = " + buffer.byteLength);
  var bytes = new Uint8Array(buffer);
  let pos = 0;
  function readStr() {
    while (pos < len && bytes[pos] === 10) pos++; //skip blank lines
    let startPos = pos;
    while (pos < len && bytes[pos] !== 10) pos++;
    pos++; //skip EOLN
    if (pos - startPos < 1) return "";
    return new TextDecoder().decode(buffer.slice(startPos, pos - 1));
  }
  let line = readStr(); //1st line: signature
  if (!line.startsWith("# vtk DataFile")) alert("Invalid VTK mesh");
  line = readStr(); //2nd line comment
  line = readStr(); //3rd line ASCII/BINARY
  if (line.startsWith("ASCII")) return readTxtVTK(buffer); //from NiiVue
  else if (!line.startsWith("BINARY"))
    alert("Invalid VTK image, expected ASCII or BINARY", line);
  line = readStr(); //5th line "DATASET POLYDATA"
  if (!line.includes("POLYDATA")) alert("Only able to read VTK POLYDATA", line);
  line = readStr(); //6th line "POINTS 10261 float"
  if (
    !line.includes("POINTS") ||
    (!line.includes("double") && !line.includes("float"))
  )
    console.log("Only able to read VTK float or double POINTS" + line);
  let isFloat64 = line.includes("double");
  let items = line.split(" ");
  let nvert = parseInt(items[1]); //POINTS 10261 float
  let nvert3 = nvert * 3;
  var positions = new Float32Array(nvert3);
  var reader = new DataView(buffer);
  if (isFloat64) {
    for (let i = 0; i < nvert3; i++) {
      positions[i] = reader.getFloat64(pos, false);
      pos += 8;
    }
  } else {
    for (let i = 0; i < nvert3; i++) {
      positions[i] = reader.getFloat32(pos, false);
      pos += 4;
    }
  }
  line = readStr(); //Type, "LINES 11885 "
  items = line.split(" ");
  let tris = [];
  if (items[0].includes("LINES")) {
    let n_count = parseInt(items[1]);
    //tractogaphy data: detect if borked by DiPy
    let posOK = pos;
    line = readStr(); //borked files "OFFSETS vtktypeint64"
    if (line.startsWith("OFFSETS")) {
      //console.log("invalid VTK file created by DiPy");
      let isInt64 = false;
      if (line.includes("int64")) isInt64 = true;
      let offsetPt0 = new Uint32Array(n_count);
      if (isInt64) {
        let isOverflowInt32 = false;
        for (let c = 0; c < n_count; c++) {
          let idx = reader.getInt32(pos, false);
          if (idx !== 0) isOverflowInt32 = true;
          pos += 4;
          idx = reader.getInt32(pos, false);
          pos += 4;
          offsetPt0[c] = idx;
        }
        if (isOverflowInt32)
          console.log("int32 overflow: JavaScript does not support int64");
      } else {
        for (let c = 0; c < n_count; c++) {
          let idx = reader.getInt32(pos, false);
          pos += 4;
          offsetPt0[c] = idx;
        }
      }
      let pts = positions;
      return {
        pts,
        offsetPt0,
      };
    }
    pos = posOK; //valid VTK file
    let npt = 0;
    let offsetPt0 = [];
    let pts = [];
    offsetPt0.push(npt); //1st streamline starts at 0
    for (let c = 0; c < n_count; c++) {
      let numPoints = reader.getInt32(pos, false);
      pos += 4;
      npt += numPoints;
      offsetPt0.push(npt);
      for (let i = 0; i < numPoints; i++) {
        let idx = reader.getInt32(pos, false) * 3;
        pos += 4;
        pts.push(positions[idx + 0]);
        pts.push(positions[idx + 1]);
        pts.push(positions[idx + 2]);
      } //for numPoints: number of segments in streamline
    } //for n_count: number of streamlines
    return {
      pts,
      offsetPt0,
    };
  } else if (items[0].includes("TRIANGLE_STRIPS")) {
    let nstrip = parseInt(items[1]);
    for (let i = 0; i < nstrip; i++) {
      let ntri = reader.getInt32(pos, false) - 2; //-2 as triangle strip is creates pts - 2 faces
      pos += 4;
      for (let t = 0; t < ntri; t++) {
        if (t % 2) {
          // preserve winding order
          tris.push(reader.getInt32(pos + 8, false));
          tris.push(reader.getInt32(pos + 4, false));
          tris.push(reader.getInt32(pos, false));
        } else {
          tris.push(reader.getInt32(pos, false));
          tris.push(reader.getInt32(pos + 4, false));
          tris.push(reader.getInt32(pos + 8, false));
        }
        pos += 4;
      } //for each triangle
      pos += 8;
    } //for each strip
  } else if (items[0].includes("POLYGONS")) {
    let npoly = parseInt(items[1]);
    for (let i = 0; i < npoly; i++) {
      let ntri = reader.getInt32(pos, false) - 2; //3 for single triangle, 4 for 2 triangles
      pos += 4;
      let fx = reader.getInt32(pos, false);
      pos += 4;
      let fy = reader.getInt32(pos, false);
      pos += 4;
      for (let t = 0; t < ntri; t++) {
        let fz = reader.getInt32(pos, false);
        pos += 4;
        tris.push(fx);
        tris.push(fy);
        tris.push(fz);
        fy = fz;
      } //for each triangle
    } //for each polygon
  } else alert("Unsupported ASCII VTK datatype ", items[0]);
  var indices = new Int32Array(tris);
  return {
    positions,
    indices,
  };
}; // readVTK()

NVMesh.readDFS = function (buffer, n_vert = 0) {
  //http://brainsuite.org/formats/dfs/
  //Does not play with other formats: vertex positions do not use Aneterior Commissure as origin
  var reader = new DataView(buffer);
  var magic = reader.getUint32(0, true); //"DFS_"
  var LE = reader.getUint16(4, true); //"LE"
  if (magic !== 1599292996 || LE !== 17740)
    console.log("Not a little-endian brainsuite DFS mesh");
  var hdrBytes = reader.getUint32(12, true);
  //var mdoffset = reader.getUint32(16, true);
  //var pdoffset = reader.getUint32(20, true);
  var nface = reader.getUint32(24, true); //number of triangles
  var nvert = reader.getUint32(28, true);
  //var nStrips = reader.getUint32(32, true); //deprecated
  //var stripSize = reader.getUint32(36, true); //deprecated
  //var normals = reader.getUint32(40, true);
  //var uvStart = reader.getUint32(44, true);
  var vcoffset = reader.getUint32(48, true); //vertexColor offset
  //var precision = reader.getUint32(52, true);
  // float64 orientation[4][4]; //4x4 matrix, affine transformation to world coordinates*)
  let pos = hdrBytes;
  let indices = new Int32Array(buffer, pos, nface * 3, true);
  pos += nface * 3 * 4;
  let positions = new Float32Array(buffer, pos, nvert * 3, true);
  //oops, triangle winding opposite of CCW convention
  for (var i = 0; i < nvert * 3; i += 3) {
    let tmp = positions[i];
    positions[i] = positions[i + 1];
    positions[i + 1] = tmp;
  }
  var colors = null;
  if (vcoffset >= 0)
    colors = new Float32Array(buffer, vcoffset, nvert * 3, true);
  return {
    positions,
    indices,
    colors,
  };
};

NVMesh.readMZ3 = function (buffer, n_vert = 0) {
  //ToDo: mz3 always little endian: support big endian? endian https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Float32Array
  if (buffer.byteLength < 20)
    //76 for raw, not sure of gzip
    throw new Error("File too small to be mz3: bytes = " + buffer.byteLength);
  var reader = new DataView(buffer);
  //get number of vertices and faces
  var magic = reader.getUint16(0, true);
  var _buffer = buffer;
  if (magic === 35615 || magic === 8075) {
    //gzip signature 0x1F8B in little and big endian
    var raw = fflate.decompressSync(new Uint8Array(buffer));
    reader = new DataView(raw.buffer);
    var magic = reader.getUint16(0, true);
    _buffer = raw.buffer;
    //throw new Error( 'Gzip MZ3 file' );
  }
  var attr = reader.getUint16(2, true);
  var nface = reader.getUint32(4, true);
  var nvert = reader.getUint32(8, true);
  var nskip = reader.getUint32(12, true);
  log.debug(
    "MZ3 magic %d attr %d face %d vert %d skip %d",
    magic,
    attr,
    nface,
    nvert,
    nskip
  );
  if (magic != 23117) throw new Error("Invalid MZ3 file");
  var isFace = attr & 1;
  var isVert = attr & 2;
  var isRGBA = attr & 4;
  var isSCALAR = attr & 8;
  var isDOUBLE = attr & 16;
  var isAOMap = attr & 32;
  if (attr > 63) throw new Error("Unsupported future version of MZ3 file");
  if (nvert < 3) throw new Error("Not a mesh MZ3 file (maybe scalar)");
  if (n_vert > 0 && n_vert !== nvert) {
    console.log(
      "Layer has " + nvert + "vertices, but background mesh has " + n_vert
    );
  }
  var filepos = 16 + nskip;
  var indices = null;
  if (isFace) {
    indices = new Int32Array(_buffer, filepos, nface * 3, true);
    filepos += nface * 3 * 4;
  }
  var positions = null;
  if (isVert) {
    positions = new Float32Array(_buffer, filepos, nvert * 3, true);
    filepos += nvert * 3 * 4;
  }
  var colors = null;
  if (isRGBA) {
    colors = new Float32Array(nvert * 3);
    var rgba8 = new Uint8Array(_buffer, filepos, nvert * 4, true);
    filepos += nvert * 4;
    var k3 = 0;
    var k4 = 0;
    for (var i = 0; i < nvert; i++) {
      for (var j = 0; j < 3; j++) {
        //for RGBA
        colors[k3] = rgba8[k4] / 255;
        k3++;
        k4++;
      }
      k4++; //skip Alpha
    } //for i
  } //if isRGBA
  let scalars = [];
  if (!isRGBA && isSCALAR) {
    let nFrame4D = Math.floor((_buffer.byteLength - filepos) / 4 / nvert);
    if (nFrame4D < 1) {
      console.log("MZ3 corrupted");
      return;
    }
    scalars = new Float32Array(_buffer, filepos, nFrame4D * nvert);
    filepos += nvert * 4;
  }
  if (n_vert > 0) return scalars;
  return {
    positions,
    indices,
    scalars,
    colors,
  };
}; // readMZ3()

NVMesh.readPLY = function (buffer) {
  //https://en.wikipedia.org/wiki/PLY_(file_format)
  let len = buffer.byteLength;
  var bytes = new Uint8Array(buffer);
  let pos = 0;
  function readStr() {
    while (pos < len && bytes[pos] === 10) pos++; //skip blank lines
    let startPos = pos;
    while (pos < len && bytes[pos] !== 10) pos++;
    pos++; //skip EOLN
    if (pos - startPos < 1) return "";
    return new TextDecoder().decode(buffer.slice(startPos, pos - 1));
  }
  let line = readStr(); //1st line: magic 'ply'
  if (!line.startsWith("ply")) {
    console.log("Not a valid PLY file");
    return;
  }
  line = readStr(); //2nd line: format 'format binary_little_endian 1.0'
  let isAscii = line.includes("ascii");
  function dataTypeBytes(str) {
    if (str === "char" || str === "uchar" || str === "int8" || str === "uint8")
      return 1;
    if (
      str === "short" ||
      str === "ushort" ||
      str === "int16" ||
      str === "uint16"
    )
      return 2;
    if (
      str === "int" ||
      str === "uint" ||
      str === "int32" ||
      str === "uint32" ||
      str === "float" ||
      str === "float32"
    )
      return 4;
    if (str === "double") return 8;
    console.log("Unknown data type: " + str);
  }
  let isLittleEndian = line.includes("binary_little_endian");
  let nvert = 0;
  let vertIsDouble = false;
  let vertStride = 0; //e.g. if each vertex stores xyz as float32 and rgb as uint8, stride is 15
  let indexCountBytes = 0; //if "property list uchar int vertex_index" this is 1 (uchar)
  let indexBytes = 0; //if "property list uchar int vertex_index" this is 4 (int)
  let nface = 0;
  while (pos < len && !line.startsWith("end_header")) {
    line = readStr();
    if (line.startsWith("comment")) continue;
    //line = line.replaceAll('\t', ' '); // ?are tabs valid white space?
    let items = line.split(/\s/);
    if (line.startsWith("element vertex")) {
      nvert = parseInt(items[items.length - 1]);
      //read vertex properties:
      line = readStr();
      items = line.split(/\s/);
      while (line.startsWith("property")) {
        let datatype = items[1];
        if (items[2] === "x" && datatype.startsWith("double"))
          vertIsDouble = true;
        else if (items[2] === "x" && !datatype.startsWith("float"))
          console.log("Error: expect ply xyz to be float or double: " + line);
        vertStride += dataTypeBytes(datatype);
        line = readStr();
        items = line.split(/\s/);
      }
    }
    if (
      items[items.length - 1] === "vertex_indices" ||
      items[items.length - 1] === "vertex_index"
    ) {
      indexCountBytes = dataTypeBytes(items[2]);
      indexBytes = dataTypeBytes(items[3]);
      continue;
    }
    if (line.startsWith("element face"))
      nface = parseInt(items[items.length - 1]);
  } //while reading all lines of header
  if (vertStride < 12 || indexCountBytes < 1 || indexBytes < 1 || nface < 1)
    console.log("Malformed ply format");
  if (isAscii) {
    let positions = new Float32Array(nvert * 3);
    let v = 0;
    for (var i = 0; i < nvert; i++) {
      line = readStr();
      let items = line.split(/\s/);
      positions[v] = parseFloat(items[0]);
      positions[v + 1] = parseFloat(items[1]);
      positions[v + 2] = parseFloat(items[2]);
      v += 3;
    }
    let indices = new Int32Array(nface * 3);
    let f = 0;
    let isTriangular = true;
    for (var i = 0; i < nface; i++) {
      line = readStr();
      let items = line.split(/\s/);
      if (parseInt(items[0]) > 3) isTriangular = false;
      indices[f] = parseInt(items[1]);
      indices[f + 1] = parseInt(items[2]);
      indices[f + 2] = parseInt(items[3]);
      f += 3;
    }
    if (!isTriangular)
      console.log("Only able to read PLY meshes limited to triangles.");
    return {
      positions,
      indices,
    };
  } //if isAscii
  var reader = new DataView(buffer);
  var positions = [];
  if (vertStride === 12 && isLittleEndian) {
    //optimization: vertices only store xyz position as float
    positions = new Float32Array(buffer, pos, nvert * 3);
    pos += nvert * vertStride;
  } else {
    positions = new Float32Array(nvert * 3);
    let v = 0;
    for (var i = 0; i < nvert; i++) {
      if (vertIsDouble) {
        positions[v] = reader.getFloat64(pos, isLittleEndian);
        positions[v + 1] = reader.getFloat64(pos + 8, isLittleEndian);
        positions[v + 2] = reader.getFloat64(pos + 16, isLittleEndian);
      } else {
        positions[v] = reader.getFloat32(pos, isLittleEndian);
        positions[v + 1] = reader.getFloat32(pos + 4, isLittleEndian);
        positions[v + 2] = reader.getFloat32(pos + 8, isLittleEndian);
      }
      v += 3;
      pos += vertStride;
    }
  }
  var indices = new Int32Array(nface * 3); //assume triangular mesh: pre-allocation optimization
  let isTriangular = true;
  let j = 0;
  if (indexCountBytes === 1 && indexBytes === 4) {
    for (var i = 0; i < nface; i++) {
      let nIdx = reader.getUint8(pos);
      pos += indexCountBytes;
      if (nIdx !== 3) isTriangular = false;
      indices[j] = reader.getUint32(pos, isLittleEndian);
      pos += 4;
      indices[j + 1] = reader.getUint32(pos, isLittleEndian);
      pos += 4;
      indices[j + 2] = reader.getUint32(pos, isLittleEndian);
      pos += 4;
      j += 3;
    }
  } else {
    //not 1:4 index data
    for (var i = 0; i < nface; i++) {
      let nIdx = 0;
      if (indexCountBytes === 1) nIdx = reader.getUint8(pos);
      else if (indexCountBytes === 2)
        nIdx = reader.getUint16(pos, isLittleEndian);
      else if (indexCountBytes === 4)
        nIdx = reader.getUint32(pos, isLittleEndian);
      pos += indexCountBytes;
      if (nIdx !== 3) isTriangular = false;
      for (var k = 0; k < 3; k++) {
        if (indexBytes === 1) indices[j] = reader.getUint8(pos, isLittleEndian);
        else if (indexBytes === 2)
          indices[j] = reader.getUint16(pos, isLittleEndian);
        else if (indexBytes === 4)
          indices[j] = reader.getUint32(pos, isLittleEndian);
        j++;
        pos += indexBytes;
      }
    } //for each face
  } //if not 1:4 datatype
  if (!isTriangular)
    console.log("Only able to read PLY meshes limited to triangles.");
  return {
    positions,
    indices,
  };
}; // readPLY()

NVMesh.readLayer = function (
  name,
  buffer,
  nvmesh,
  opacity = 0.5,
  colorMap = "warm",
  colorMapNegative = "winter",
  useNegativeCmap = false,
  cal_min = null,
  cal_max = null
) {
  let layer = [];
  let n_vert = nvmesh.vertexCount / 3; //each vertex has XYZ component
  if (n_vert < 3) return;
  var re = /(?:\.([^.]+))?$/;
  let ext = re.exec(name)[1];
  ext = ext.toUpperCase();
  if (ext === "GZ") {
    ext = re.exec(name.slice(0, -3))[1]; //img.trk.gz -> img.trk
    ext = ext.toUpperCase();
  }
  if (ext === "MZ3") layer.values = this.readMZ3(buffer, n_vert);
  else if (ext === "ANNOT") layer.values = this.readANNOT(buffer, n_vert);
  else if (ext === "CRV" || ext === "CURV")
    layer.values = this.readCURV(buffer, n_vert);
  else if (ext === "GII") layer.values = this.readGII(buffer, n_vert);
  else if (ext === "STC") layer.values = this.readSTC(buffer, n_vert);
  else {
    console.log("Unknown layer overlay format " + name);
    return;
  }
  if (!layer.values) return;
  layer.nFrame4D = layer.values.length / n_vert;
  layer.frame4D = 0;
  //determine global min..max
  let mn = layer.values[0];
  let mx = layer.values[0];
  for (var i = 0; i < layer.values.length; i++) {
    mn = Math.min(mn, layer.values[i]);
    mx = Math.max(mx, layer.values[i]);
  }
  layer.global_min = mn;
  layer.global_max = mx;
  layer.cal_min = cal_min;
  if (!cal_min) layer.cal_min = mn;
  layer.cal_max = cal_max;
  if (!cal_max) layer.cal_max = mx;
  layer.opacity = opacity;
  layer.colorMap = colorMap;
  layer.colorMapNegative = colorMapNegative;
  layer.useNegativeCmap = useNegativeCmap;
  nvmesh.layers.push(layer);
}; // readLayer()

NVMesh.readOFF = function (buffer) {
  //https://en.wikipedia.org/wiki/OFF_(file_format)
  var enc = new TextDecoder("utf-8");
  var txt = enc.decode(buffer);
  //let txt = await response.text();
  var lines = txt.split("\n");
  var n = lines.length;
  let pts = [];
  let t = [];
  let i = 0;
  if (!lines[i].startsWith("OFF")) {
    console.log("File does not start with OFF");
  } else i++;
  let items = lines[i].split(" ");
  let num_v = parseInt(items[0]);
  let num_f = parseInt(items[1]);
  i++;
  for (let j = 0; j < num_v; j++) {
    let str = lines[i];
    items = str.split(" ");
    pts.push(parseFloat(items[0]));
    pts.push(parseFloat(items[1]));
    pts.push(parseFloat(items[2]));
    i++;
  }
  for (let j = 0; j < num_f; j++) {
    let str = lines[i];
    items = str.split(" ");
    let n = parseInt(items[0]);
    if (n !== 3)
      console.log("Only able to read OFF files with triangular meshes");
    t.push(parseInt(items[1]));
    t.push(parseInt(items[2]));
    t.push(parseInt(items[3]));
    i++;
  }
  var positions = new Float32Array(pts);
  var indices = new Int32Array(t);
  return {
    positions,
    indices,
  };
}; // readOFF()

NVMesh.readOBJ = function (buffer) {
  //WaveFront OBJ format
  var enc = new TextDecoder("utf-8");
  var txt = enc.decode(buffer);
  //let txt = await response.text();
  var lines = txt.split("\n");
  var n = lines.length;
  let pts = [];
  let t = [];
  for (let i = 0; i < n; i++) {
    let str = lines[i];
    if (str[0] === "v" && str[1] === " ") {
      //'v ' but not 'vt' or 'vn'
      let items = str.split(" ");
      pts.push(parseFloat(items[1]));
      pts.push(parseFloat(items[2]));
      pts.push(parseFloat(items[3]));
      //v 0 -0.5 -0
    }
    if (str[0] === "f") {
      let items = str.split(" ");
      let tn = items[1].split("/");
      t.push(parseInt(tn - 1));
      tn = items[2].split("/");
      t.push(parseInt(tn - 1));
      tn = items[3].split("/");
      t.push(parseInt(tn - 1));
    }
  } //for all lines
  var positions = new Float32Array(pts);
  var indices = new Int32Array(t);
  return {
    positions,
    indices,
  };
}; // readOBJ()

NVMesh.readFreeSurfer = function (buffer) {
  const view = new DataView(buffer); //ArrayBuffer to dataview
  //ALWAYS big endian
  let sig0 = view.getUint32(0, false);
  let sig1 = view.getUint32(4, false);
  if (sig0 !== 4294966883 || sig1 !== 1919246708)
    log.debug(
      "Unable to recognize file type: does not appear to be FreeSurfer format."
    );
  let offset = 0;
  while (view.getUint8(offset) !== 10) offset++;
  offset += 2;
  let nv = view.getUint32(offset, false); //number of vertices
  offset += 4;
  let nf = view.getUint32(offset, false); //number of faces
  offset += 4;
  nv *= 3; //each vertex has 3 positions: XYZ
  var positions = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    positions[i] = view.getFloat32(offset, false);
    offset += 4;
  }
  nf *= 3; //each triangle face indexes 3 triangles
  var indices = new Int32Array(nf);
  for (let i = 0; i < nf; i++) {
    indices[i] = view.getUint32(offset, false);
    offset += 4;
  }
  return {
    positions,
    indices,
  };
}; // readFreeSurfer()

NVMesh.readSRF = function (buffer) {
  //https://support.brainvoyager.com/brainvoyager/automation-development/84-file-formats/344-users-guide-2-3-the-format-of-srf-files
  var bytes = new Uint8Array(buffer);
  if (bytes[0] === 31 && bytes[1] === 139) {
    // handle .srf.gz
    var raw = fflate.decompressSync(new Uint8Array(buffer));
    buffer = raw.buffer;
  }
  var reader = new DataView(buffer);
  let ver = reader.getFloat32(0, true);
  let nVert = reader.getUint32(8, true);
  let nTri = reader.getUint32(12, true);
  let oriX = reader.getFloat32(16, true);
  let oriY = reader.getFloat32(20, true);
  let oriZ = reader.getFloat32(24, true);
  var positions = new Float32Array(nVert * 3);
  //BrainVoyager does not use Talairach coordinates for XYZ!
  //read X component of each vertex
  let pos = 28;
  let j = 1; //BrainVoyager X is Talairach Y
  for (var i = 0; i < nVert; i++) {
    positions[j] = -reader.getFloat32(pos, true) + oriX;
    j += 3; //read one of 3 components: XYZ
    pos += 4; //read one float32
  }
  //read Y component of each vertex
  j = 2; //BrainVoyager Y is Talairach Z
  for (var i = 0; i < nVert; i++) {
    positions[j] = -reader.getFloat32(pos, true) + oriY;
    j += 3; //read one of 3 components: XYZ
    pos += 4; //read one float32
  }
  //read Z component of each vertex
  j = 0; //BrainVoyager Z is Talairach X
  for (var i = 0; i < nVert; i++) {
    positions[j] = -reader.getFloat32(pos, true) + oriZ;
    j += 3; //read one of 3 components: XYZ
    pos += 4; //read one float32
  }
  //not sure why normals are stored, does bulk up file size
  pos = 28 + 4 * 6 * nVert; //each vertex has 6 float32s: XYZ for position and normal
  //read concave and convex colors:
  let rVex = reader.getFloat32(pos, true);
  let gVex = reader.getFloat32(pos + 4, true);
  let bVex = reader.getFloat32(pos + 8, true);
  let rCave = reader.getFloat32(pos + 16, true);
  let gCave = reader.getFloat32(pos + 20, true);
  let bCave = reader.getFloat32(pos + 24, true);
  pos += 8 * 4; //skip 8 floats (RGBA convex/concave)
  //read per-vertex colors
  let colors = new Float32Array(nVert * 3);
  let colorsIdx = new Uint32Array(buffer, pos, nVert, true);
  j = 0; //convert RGBA -> RGB
  for (var i = 0; i < nVert; i++) {
    let c = colorsIdx[i];
    if (c > 1056964608) {
      colors[j + 0] = ((c >> 16) & 0xff) / 255;
      colors[j + 1] = ((c >> 8) & 0xff) / 255;
      colors[j + 2] = (c & 0xff) / 255;
    }
    if (c === 0) {
      //convex
      colors[j + 0] = rVex;
      colors[j + 1] = gVex;
      colors[j + 2] = bVex;
    }
    if (c === 1) {
      //concave
      colors[j + 0] = rCave;
      colors[j + 1] = gCave;
      colors[j + 2] = bCave;
    }
    j += 3;
  }
  pos += nVert * 4; // MeshColor, sequence of color indices
  //not sure why nearest neighbors are stored, slower and bigger files
  for (var i = 0; i < nVert; i++) {
    let nNearest = reader.getUint32(pos, true);
    pos += 4 + 4 * nNearest;
  }
  var indices = new Int32Array(nTri * 3);
  for (var i = 0; i < nTri * 3; i++) {
    indices[i] = reader.getInt32(pos, true);
    pos += 4;
  }
  if (ver !== 4) console.log("Not valid SRF");

  return {
    positions,
    indices,
    colors,
  };
}; // readSRF()

NVMesh.readSTL = function (buffer) {
  if (buffer.byteLength < 80 + 4 + 50)
    throw new Error("File too small to be STL: bytes = " + buffer.byteLength);
  var reader = new DataView(buffer);
  let sig = reader.getUint32(80, true);
  if (sig === 1768714099)
    throw new Error("Only able to read binary (not ASCII) STL files.");
  var ntri = reader.getUint32(80, true);
  let ntri3 = 3 * ntri;
  if (buffer.byteLength < 80 + 4 + ntri * 50)
    throw new Error("STL file too small to store triangles = ", ntri);
  var indices = new Int32Array(ntri3);
  var positions = new Float32Array(ntri3 * 3);
  let pos = 80 + 4 + 12;
  let v = 0; //vertex
  for (var i = 0; i < ntri; i++) {
    for (var j = 0; j < 9; j++) {
      positions[v] = reader.getFloat32(pos, true);
      v += 1;
      pos += 4;
    }
    pos += 14; //50 bytes for triangle, only 36 used for position
  }
  for (var i = 0; i < ntri3; i++) indices[i] = i;
  return {
    positions,
    indices,
  };
}; // readSTL()

NVMesh.readGII = function (buffer, n_vert = 0) {
  var enc = new TextDecoder("utf-8");
  var xmlStr = enc.decode(buffer);
  let gii = gifti.parse(xmlStr);
  if (n_vert > 0) {
    //add as overlay layer
    if (gii.dataArrays.length < 0) {
      console.log("Not a valid GIfTI overlay");
    }
    let scalars = [];
    for (var i = 0; i < gii.dataArrays.length; i++) {
      let layer = gii.dataArrays[i];
      if (n_vert !== layer.getNumElements()) {
        console.log(
          "Number of vertices of overlay layer does not match mesh " +
            n_vert +
            " vs " +
            getNumElements()
        );
        return;
      }
      if (layer.isColors()) console.log("TODO: check color mesh layers");
      let scalarsI = new Float32Array(layer.getData());
      scalars.push(...scalarsI);
    }
    return scalars;
  }
  if (gii.getNumTriangles() === 0 || gii.getNumPoints() === 0) {
    console.log("Not a GIfTI mesh (perhaps an overlay layer)");
    return;
  }
  var positions = gii.getPointsDataArray().getData();
  var indices = gii.getTrianglesDataArray().getData();
  //next: ColumnMajorOrder https://github.com/rii-mango/GIFTI-Reader-JS/issues/2
  if (
    gii.getPointsDataArray().attributes.ArrayIndexingOrder ===
    "ColumnMajorOrder"
  ) {
    //transpose points, xx..xyy..yzz..z -> xyzxyz..
    let ps = positions.slice();
    let np = ps.length / 3;
    let j = 0;
    for (var p = 0; p < np; p++)
      for (var i = 0; i < 3; i++) {
        positions[j] = ps[i * np + p];
        j++;
      }
  }
  if (
    gii.getTrianglesDataArray().attributes.ArrayIndexingOrder ===
    "ColumnMajorOrder"
  ) {
    //transpose indices, xx..xyy..yzz..z -> xyzxyz..
    let ps = indices.slice();
    let np = ps.length / 3;
    let j = 0;
    for (var p = 0; p < np; p++)
      for (var i = 0; i < 3; i++) {
        indices[j] = ps[i * np + p];
        j++;
      }
  }
  return {
    positions,
    indices,
  };
}; // readGII()

NVMesh.loadConnectomeFromJSON = async function (
  json,
  gl,
  name = "",
  colorMap = "",
  opacity = 1.0,
  visible = true
) {
  if (json.hasOwnProperty("name")) name = json.name;
  return new NVMesh([], [], name, [], opacity, visible, gl, json);
}; //loadConnectomeFromJSON()

NVMesh.readMesh = async function (
  buffer,
  name,
  gl,
  opacity = 1.0,
  rgba255 = [255, 255, 255, 255],
  visible = true
) {
  let nvmesh = null;
  let tris = [];
  let pts = [];
  let obj = [];
  var re = /(?:\.([^.]+))?$/;
  let ext = re.exec(name)[1];
  ext = ext.toUpperCase();
  if (ext === "GZ") {
    ext = re.exec(name.slice(0, -3))[1]; //img.trk.gz -> img.trk
    ext = ext.toUpperCase();
  }
  if (ext === "TCK" || ext === "TRK" || ext === "TRX") {
    if (ext === "TCK") obj = this.readTCK(buffer);
    else if (ext === "TRX") obj = await this.readTRX(buffer);
    else obj = this.readTRK(buffer);
    //let offsetPt0 = new Int32Array(obj.offsetPt0.slice());
    //let pts = new Float32Array(obj.pts.slice());
    let offsetPt0 = new Int32Array(obj.offsetPt0.slice());
    let pts = new Float32Array(obj.pts.slice());
    if (!obj.hasOwnProperty("dpg")) obj.dpg = null;
    if (!obj.hasOwnProperty("dps")) obj.dps = null;
    if (!obj.hasOwnProperty("dpv")) obj.dpv = null;
    return new NVMesh(
      pts,
      offsetPt0,
      name,
      null, //colorMap,
      opacity, //opacity,
      visible, //visible,
      gl,
      "inferno",
      obj.dpg,
      obj.dps,
      obj.dpv
    );
  } //is fibers
  if (ext === "GII") {
    obj = this.readGII(buffer);
  } else if (ext === "MZ3") obj = this.readMZ3(buffer);
  else if (ext === "DFS") obj = this.readDFS(buffer);
  else if (ext === "OFF") obj = this.readOFF(buffer);
  else if (ext === "OBJ") obj = this.readOBJ(buffer);
  else if (ext === "PLY") obj = this.readPLY(buffer);
  else if (ext === "FIB" || ext === "VTK") {
    obj = this.readVTK(buffer);
    if (obj.hasOwnProperty("offsetPt0")) {
      //VTK files used both for meshes and streamlines
      let offsetPt0 = new Int32Array(obj.offsetPt0.slice());
      let pts = new Float32Array(obj.pts.slice());
      return new NVMesh(
        pts,
        offsetPt0,
        name,
        null, //colorMap,
        opacity, //opacity,
        visible, //visible,
        gl,
        "inferno"
      );
    } //if streamlines, not mesh
  } else if (ext === "SRF") {
    obj = this.readSRF(buffer);
  } else if (ext === "STL") {
    obj = this.readSTL(buffer);
  } else {
    obj = this.readFreeSurfer(buffer);
  } // freesurfer hail mary
  pts = obj.positions.slice();
  tris = obj.indices.slice();
  if (obj.colors && obj.colors.length === pts.length) {
    rgba255 = [];
    let n = pts.length / 3;
    let c = 0;
    for (let i = 0; i < n; i++) {
      //convert ThreeJS unit RGB to RGBA255
      rgba255.push(obj.colors[c] * 255); //red
      rgba255.push(obj.colors[c + 1] * 255); //green
      rgba255.push(obj.colors[c + 2] * 255); //blue
      rgba255.push(255); //alpha
      c += 3;
    } //for i: each vertex
  } //obj includes colors
  let npt = pts.length / 3;
  let ntri = tris.length / 3;
  if (ntri < 1 || npt < 3) {
    alert("Mesh should have at least one triangle and three vertices");
    return;
  }
  if (tris.constructor !== Int32Array) {
    alert("Expected triangle indices to be of type INT32");
  }

  let nvm = new NVMesh(
    pts,
    tris,
    name,
    rgba255, //colorMap,
    opacity, //opacity,
    visible, //visible,
    gl
  );
  if (obj.hasOwnProperty("scalars") && obj.scalars.length > 0) {
    this.readLayer(name, buffer, nvm, opacity, "gray");
    nvm.updateMesh(gl);
  }
  return nvm;
};

//https://stackoverflow.com/questions/55798396/how-do-i-make-a-nested-loop-continue-only-after-a-asynchronous-function-has-been
var pow = Math.pow;
function decodeFloat16(binary) {
  "use strict";
  var exponent = (binary & 0x7c00) >> 10,
    fraction = binary & 0x03ff;
  return (
    (binary >> 15 ? -1 : 1) *
    (exponent
      ? exponent === 0x1f
        ? fraction
          ? NaN
          : Infinity
        : pow(2, exponent - 15) * (1 + fraction / 0x400)
      : 6.103515625e-5 * (fraction / 0x400))
  );
}

NVMesh.readTRX = async function (buffer) {
  //Javascript does not support float16, so we convert to float32
  //https://stackoverflow.com/questions/5678432/decompressing-half-precision-floats-in-javascript
  function decodeFloat16(binary) {
    "use strict";
    var exponent = (binary & 0x7c00) >> 10,
      fraction = binary & 0x03ff;
    return (
      (binary >> 15 ? -1 : 1) *
      (exponent
        ? exponent === 0x1f
          ? fraction
            ? NaN
            : Infinity
          : Math.pow(2, exponent - 15) * (1 + fraction / 0x400)
        : 6.103515625e-5 * (fraction / 0x400))
    );
  } // decodeFloat16()
  let noff = 0;
  let npt = 0;
  let pts = [];
  let offsetPt0 = [];
  let dpg = [];
  let dps = [];
  let dpv = [];
  let header = [];
  let isOverflowUint64 = false;
  let data = [];
  /*if (urlIsLocalFile) {
    data = fs.readFileSync(url);
  } else {
    let response = await fetch(url);
    if (!response.ok) throw Error(response.statusText);
    data = await response.arrayBuffer();
  }*/
  const decompressed = fflate.unzipSync(new Uint8Array(buffer), {
    filter(file) {
      return file.originalSize > 0;
    },
  });
  var keys = Object.keys(decompressed);
  for (var i = 0, len = keys.length; i < len; i++) {
    let parts = keys[i].split("/");
    let fname = parts.slice(-1)[0]; // my.trx/dpv/fx.float32 -> fx.float32
    if (fname.startsWith(".")) continue;
    let pname = parts.slice(-2)[0]; // my.trx/dpv/fx.float32 -> dpv
    let tag = fname.split(".")[0]; // "positions.3.float16 -> "positions"
    //todo: should tags be censored for invalide characters: https://stackoverflow.com/questions/8676011/which-characters-are-valid-invalid-in-a-json-key-name
    let data = decompressed[keys[i]];
    if (fname.includes("header.json")) {
      let jsonString = new TextDecoder().decode(data);
      header = JSON.parse(jsonString);
      continue;
    }
    //next read arrays for all possible datatypes: int8/16/32/64 uint8/16/32/64 float16/32/64
    let nval = 0;
    let vals = [];
    if (fname.endsWith(".uint64") || fname.endsWith(".int64")) {
      //javascript does not have 64-bit integers! read lower 32-bits
      //note for signed int64 we only read unsigned bytes
      //for both signed and unsigned, generate an error if any value is out of bounds
      //one alternative might be to convert to 64-bit double that has a flintmax of 2^53.
      nval = data.length / 8; //8 bytes per 64bit input
      vals = new Uint32Array(nval);
      var u32 = new Uint32Array(data.buffer);
      let j = 0;
      for (let i = 0; i < nval; i++) {
        vals[i] = u32[j];
        if (u32[j + 1] !== 0) isOverflowUint64 = true;
        j += 2;
      }
    } else if (fname.endsWith(".uint32")) {
      vals = new Uint32Array(data.buffer);
    } else if (fname.endsWith(".uint16")) {
      vals = new Uint16Array(data.buffer);
    } else if (fname.endsWith(".uint8")) {
      vals = new Uint8Array(data.buffer);
    } else if (fname.endsWith(".int32")) {
      vals = new Int32Array(data.buffer);
    } else if (fname.endsWith(".int16")) {
      vals = new Int16Array(data.buffer);
    } else if (fname.endsWith(".int8")) {
      vals = new Int8Array(data.buffer);
    } else if (fname.endsWith(".float64")) {
      vals = new Float64Array(data.buffer);
    } else if (fname.endsWith(".float32")) {
      vals = new Float32Array(data.buffer);
    } else if (fname.endsWith(".float16")) {
      //javascript does not have 16-bit floats! Convert to 32-bits
      nval = data.length / 2; //2 bytes per 16bit input
      vals = new Float32Array(nval);
      var u16 = new Uint16Array(data.buffer);
      for (let i = 0; i < nval; i++) vals[i] = decodeFloat16(u16[i]);
    } else continue; //not a data array
    nval = vals.length;
    //next: read data_per_group
    if (pname.includes("dpg")) {
      dpg.push({
        id: tag,
        vals: vals.slice(),
      });
      continue;
    }
    //next: read data_per_vertex
    if (pname.includes("dpv")) {
      dpv.push({
        id: tag,
        vals: vals.slice(),
      });
      continue;
    }
    //next: read data_per_streamline
    if (pname.includes("dps")) {
      dps.push({
        id: tag,
        vals: vals.slice(),
      });
      continue;
    }
    //Next: read offsets: Always uint64
    if (fname.startsWith("offsets.")) {
      //javascript does not have 64-bit integers! read lower 32-bits
      noff = nval; //8 bytes per 64bit input
      //we need to solve the fence post problem, so we can not use slice
      offsetPt0 = new Uint32Array(nval + 1);
      for (let i = 0; i < nval; i++) offsetPt0[i] = vals[i];
    }
    if (fname.startsWith("positions.3.")) {
      npt = nval; //4 bytes per 32bit input
      pts = vals.slice();
    }
  }
  if (noff === 0 || npt === 0) alert("Failure reading TRX format");
  if (isOverflowUint64)
    alert("Too many vertices: JavaScript does not support 64 bit integers");
  offsetPt0[noff] = npt / 3; //solve fence post problem, offset for final streamline
  return {
    pts,
    offsetPt0,
    dpg,
    dps,
    dpv,
    header,
  };
}; // readTRX()

/**
 * factory function to load and return a new NVMesh instance from a given URL
 * @param {string} url the resolvable URL pointing to a nifti image to load
 * @param {string} [name=''] a name for this image. Default is an empty string
 * @param {string} [colorMap='gray'] a color map to use. default is gray
 * @param {number} [opacity=1.0] the opacity for this image. default is 1
 * @param {boolean} [visible=true] whether or not this image is to be visible
 * @returns {NVMesh} returns a NVImage intance
 * @example
 * myImage = NVMesh.loadFromUrl('./someURL/mesh.gii') // must be served from a server (local or remote)
 */
NVMesh.loadFromUrl = async function ({
  url = "",
  gl = null,
  name = "",
  opacity = 1.0,
  rgba255 = [255, 255, 255, 255],
  visible = true,
  layers = [],
} = {}) {
  let urlParts = url.split("/"); // split url parts at slash
  name = urlParts.slice(-1)[0]; // name will be last part of url (e.g. some/url/image.nii.gz --> image.nii.gz)
  if (url === "") throw Error("url must not be empty");
  if (gl === null) throw Error("gl context is null");
  //TRX format is special (its a zip archive of multiple files)
  let response = await fetch(url);
  if (!response.ok) throw Error(response.statusText);
  let tris = [];
  var pts = [];
  let buffer = await response.arrayBuffer();
  let nvmesh = await this.readMesh(buffer, name, gl, opacity, rgba255, visible);
  if (!layers || layers.length < 1) return nvmesh;
  for (let i = 0; i < layers.length; i++) {
    response = await fetch(layers[i].url);
    if (!response.ok) throw Error(response.statusText);
    buffer = await response.arrayBuffer();
    urlParts = layers[i].url.split("/");
    let opacity = 0.5;
    if (layers[i].hasOwnProperty("opacity")) opacity = layers[i].opacity;
    let colorMap = "warm";
    if (layers[i].hasOwnProperty("colorMap")) colorMap = layers[i].colorMap;
    let colorMapNegative = "winter";
    if (layers[i].hasOwnProperty("colorMapNegative"))
      colorMapNegative = layers[i].colorMapNegative;
    let useNegativeCmap = false;
    if (layers[i].hasOwnProperty("useNegativeCmap"))
      useNegativeCmap = layers[i].useNegativeCmap;
    let cal_min = null;
    if (layers[i].hasOwnProperty("cal_min")) cal_min = layers[i].cal_min;
    let cal_max = null;
    if (layers[i].hasOwnProperty("cal_max")) cal_max = layers[i].cal_max;

    this.readLayer(
      urlParts.slice(-1)[0],
      buffer,
      nvmesh,
      opacity,
      colorMap,
      colorMapNegative,
      useNegativeCmap,
      cal_min,
      cal_max
    );
  }
  nvmesh.updateMesh(gl); //apply the new properties...
  return nvmesh;
};

// not included in public docs
// loading Nifti files
NVMesh.readFileAsync = function (file) {
  return new Promise((resolve, reject) => {
    let reader = new FileReader();

    reader.onload = () => {
      resolve(reader.result);
    };

    reader.onerror = reject;

    reader.readAsArrayBuffer(file);
  });
};

/**
 * factory function to load and return a new NVImage instance from a file in the browser
 * @param {string} file the file object
 * @param {string} [name=''] a name for this image. Default is an empty string
 * @param {number} [opacity=1.0] the opacity for this image. default is 1
 * @param {boolean} [trustCalMinMax=true] whether or not to trust cal_min and cal_max from the nifti header (trusting results in faster loading)
 * @param {number} [percentileFrac=0.02] the percentile to use for setting the robust range of the display values (smart intensity setting for images with large ranges)
 * @param {boolean} [ignoreZeroVoxels=false] whether or not to ignore zero voxels in setting the robust range of display values
 * @param {boolean} [visible=true] whether or not this image is to be visible
 * @returns {NVImage} returns a NVImage intance
 * @example
 * myImage = NVImage.loadFromFile(SomeFileObject) // files can be from dialogs or drag and drop
 */
NVMesh.loadFromFile = async function ({
  file,
  gl,
  name = "",
  opacity = 1.0,
  rgba255 = [255, 255, 255, 255],
  visible = true,
  layers = [],
} = {}) {
  let buffer = await this.readFileAsync(file);
  return await this.readMesh(
    buffer,
    name,
    gl,
    opacity,
    rgba255,
    visible,
    layers
  );
};

NVMesh.loadFromBase64 = async function ({
  base64 = null,
  gl = null,
  name = "",
  opacity = 1.0,
  rgba255 = [255, 255, 255, 255],
  visible = true,
  layers = [],
} = {}) {
  //https://stackoverflow.com/questions/21797299/convert-base64-string-to-arraybuffer
  function base64ToArrayBuffer(base64) {
    var binary_string = window.atob(base64);
    var len = binary_string.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
  }

  let buffer = base64ToArrayBuffer(base64);
  return await this.readMesh(
    buffer,
    name,
    gl,
    opacity,
    rgba255,
    visible,
    layers
  );
};

String.prototype.getBytes = function () {
  //CR??? What does this do?
  let bytes = [];
  for (var i = 0; i < this.length; i++) {
    bytes.push(this.charCodeAt(i));
  }

  return bytes;
};
