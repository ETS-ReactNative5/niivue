export var vertRenderShader = `#version 300 es
#line 4
layout(location=0) in vec3 pos;
layout(location=1) in vec3 texCoords;
uniform mat4 mvpMtx;
out vec3 vColor;
void main(void) {
	gl_Position = mvpMtx * vec4(pos, 1.0); //vec4(2.0 * (pos.xyz - 0.5), 1.0);
	vColor = texCoords;
}`;

const kRenderFunc = `vec3 GetBackPosition(vec3 startPositionTex) {
	vec3 startPosition = startPositionTex * volScale; 
	vec3 invR = 1.0 / rayDir;
	vec3 tbot = invR * (vec3(0.0)-startPosition);
	vec3 ttop = invR * (volScale-startPosition);
	vec3 tmax = max(ttop, tbot);
	vec2 t = min(tmax.xx, tmax.yz);
	vec3 endPosition = startPosition + (rayDir * min(t.x, t.y));
	//convert world position back to texture position:
	endPosition = endPosition / volScale;
	return endPosition;
}
vec4 applyClip (vec3 dir, inout vec4 samplePos, inout float len, inout bool isClip) {
	float cdot = dot(dir,clipPlane.xyz);
	isClip = false;
	if  ((clipPlane.a > 1.0) || (cdot == 0.0)) return samplePos;
	bool frontface = (cdot > 0.0);
	float clipThick = 2.0;
	float dis = (-clipPlane.a - dot(clipPlane.xyz, samplePos.xyz-0.5)) / cdot;
	float  disBackFace = (-(clipPlane.a-clipThick) - dot(clipPlane.xyz, samplePos.xyz-0.5)) / cdot;
	if (((frontface) && (dis >= len)) || ((!frontface) && (dis <= 0.0))) {
		samplePos.a = len + 1.0;
		return samplePos;
	}
	if (frontface) {
		dis = max(0.0, dis);
		samplePos = vec4(samplePos.xyz+dir * dis, dis);
		if (dis > 0.0) isClip = true;
		len = min(disBackFace, len);
	}
	if (!frontface) {
		len = min(dis, len);
		disBackFace = max(0.0, disBackFace);
		if (len == dis) isClip = true;
		samplePos = vec4(samplePos.xyz+dir * disBackFace, disBackFace);
	}
	return samplePos;
}`;
export var fragRenderShaderMIP =
  `#version 300 es
#line 14
precision highp int;
precision highp float;
uniform vec3 rayDir;
uniform vec3 texVox;
uniform vec3 volScale;
uniform vec4 clipPlane;
uniform highp sampler3D volume, overlay;
uniform float overlays;
uniform float backOpacity;
uniform mat4 mvpMtx;
uniform mat4 matRAS;
uniform vec4 clipPlaneColor;
in vec3 vColor;
out vec4 fColor;
` +
  kRenderFunc +
  `
float frac2ndc(vec3 frac) {
//https://stackoverflow.com/questions/7777913/how-to-render-depth-linearly-in-modern-opengl-with-gl-fragcoord-z-in-fragment-sh
	vec4 pos = vec4(frac.xyz, 1.0); //fraction
	vec4 dim = vec4(vec3(textureSize(volume, 0)), 1.0);
	pos = pos * dim;
	vec4 shim = vec4(-0.5, -0.5, -0.5, 0.0);
	pos += shim;
	vec4 mm = transpose(matRAS) * pos;
	float z_ndc = (mvpMtx * vec4(mm.xyz, 1.0)).z;
	return (z_ndc + 1.0) / 2.0;
	
}
void main() {
	fColor = vec4(0.0,0.0,0.0,0.0);
	//fColor = vec4(vColor.rgb, 1.0); return;
	vec3 start = vColor;
	gl_FragDepth = 0.0;
	vec3 backPosition = GetBackPosition(start);
	// fColor = vec4(backPosition, 1.0); return;
	vec3 dir = backPosition - start;
	float len = length(dir);
	float lenVox = length((texVox * start) - (texVox * backPosition));
	if ((lenVox < 0.5) || (len > 3.0)) { //length limit for parallel rays
		return;
	}
	float sliceSize = len / lenVox; //e.g. if ray length is 1.0 and traverses 50 voxels, each voxel is 0.02 in unit cube
	float stepSize = sliceSize; //quality: larger step is faster traversal, but fewer samples
	float opacityCorrection = stepSize/sliceSize;
	dir = normalize(dir);
	vec4 deltaDir = vec4(dir.xyz * stepSize, stepSize);
	vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	float lenNoClip = len;
	bool isClip = false;
	vec4 clipPos = applyClip(dir, samplePos, len, isClip);
	//if ((clipPos.a != samplePos.a) && (len < 3.0)) {
	//start: OPTIONAL fast pass: rapid traversal until first hit
	float stepSizeFast = sliceSize * 1.9;
	vec4 deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(volume, samplePos.xyz).a;
		if (val > 0.01) break;
		samplePos += deltaDirFast; //advance ray position
	}
	if ((samplePos.a >= len) && (overlays < 1.0)) {
		if (isClip)
			fColor += clipPlaneColor;
		return;
	}
	fColor = vec4(1.0, 1.0, 1.0, 1.0);
	//gl_FragDepth = frac2ndc(samplePos.xyz); //crude due to fast pass resolution
	samplePos -= deltaDirFast;
	if (samplePos.a < 0.0)
		vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	//end: fast pass
	vec4 colAcc = vec4(0.0,0.0,0.0,0.0);
	vec4 firstHit = vec4(0.0,0.0,0.0,2.0 * lenNoClip);
	const float earlyTermination = 0.95;
	float backNearest = len; //assume no hit
	float ran = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
	samplePos += deltaDir * ran; //jitter ray
	while (samplePos.a <= len) {
		vec4 colorSample = texture(volume, samplePos.xyz);
		samplePos += deltaDir; //advance ray position
		if (colorSample.a < 0.01) continue;
		if (firstHit.a > lenNoClip)
			firstHit = samplePos;
		backNearest = min(backNearest, samplePos.a);
		if (colorSample.a > colAcc.a) //ties generate errors for TT_desai_dd_mpm
			colAcc = vec4(colorSample.rgb, colorSample.a+0.00001);
	}
	if (firstHit.a < len)
		gl_FragDepth = frac2ndc(firstHit.xyz);
	colAcc.a *= backOpacity;
	fColor = colAcc;
	if (isClip) //CR
		fColor.rgb = mix(fColor.rgb, clipPlaneColor.rgb, clipPlaneColor.a * 0.15);
	if (overlays < 1.0) return;
	//overlay pass
	len = lenNoClip;
	samplePos = vec4(start.xyz, 0.0); //ray position
	//start: OPTIONAL fast pass: rapid traversal until first hit
	stepSizeFast = sliceSize * 1.9;
	deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(overlay, samplePos.xyz).a;
		if (val > 0.01) break;
		samplePos += deltaDirFast; //advance ray position
	}
	if (samplePos.a >= len) {
		if (isClip && (fColor.a == 0.0))
			fColor += clipPlaneColor;
		return;
	}
	samplePos -= deltaDirFast;
	if (samplePos.a < 0.0)
		vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	//end: fast pass
	float overFarthest = len;
	colAcc = vec4(0.0, 0.0, 0.0, 0.0);
	samplePos += deltaDir * ran; //jitter ray
	vec4 overFirstHit = vec4(0.0,0.0,0.0,2.0 * len);
	while (samplePos.a <= len) {
		vec4 colorSample = texture(overlay, samplePos.xyz);
		samplePos += deltaDir; //advance ray position
		if (colorSample.a < 0.01) continue;
		if (overFirstHit.a > len)
			overFirstHit = samplePos;
		colorSample.a = 1.0-pow((1.0 - colorSample.a), opacityCorrection);
		colorSample.rgb *= colorSample.a;
		colAcc= (1.0 - colAcc.a) * colorSample + colAcc;
		overFarthest = samplePos.a;
		if ( colAcc.a > earlyTermination )
			break;
	}
	if (overFirstHit.a < firstHit.a)
	//if (overFirstHit.a < len)
		gl_FragDepth = frac2ndc(overFirstHit.xyz);
	float overMix = colAcc.a;
	float overlayDepth = 0.3;
	if (fColor.a <= 0.0)
			overMix = 1.0;
	else if (((overFarthest) > backNearest)) {
		float dx = (overFarthest - backNearest)/1.73;
		dx = fColor.a * pow(dx, overlayDepth);
		overMix *= 1.0 - dx;
	}
	fColor.rgb = mix(fColor.rgb, colAcc.rgb, overMix);
	fColor.a = max(fColor.a, colAcc.a);
}`;

export var fragRenderShader =
  `#version 300 es
#line 14
precision highp int;
precision highp float;
uniform vec3 rayDir;
uniform vec3 texVox;
uniform int backgroundMasksOverlays;
uniform vec3 volScale;
uniform vec4 clipPlane;
uniform highp sampler3D volume, overlay;
uniform float overlays;
uniform float backOpacity;
uniform mat4 mvpMtx;
uniform mat4 matRAS;
uniform vec4 clipPlaneColor;
in vec3 vColor;
out vec4 fColor;
` +
  kRenderFunc +
  `
float frac2ndc(vec3 frac) {
//https://stackoverflow.com/questions/7777913/how-to-render-depth-linearly-in-modern-opengl-with-gl-fragcoord-z-in-fragment-sh
	vec4 pos = vec4(frac.xyz, 1.0); //fraction
	vec4 dim = vec4(vec3(textureSize(volume, 0)), 1.0);
	pos = pos * dim;
	vec4 shim = vec4(-0.5, -0.5, -0.5, 0.0);
	pos += shim;
	vec4 mm = transpose(matRAS) * pos;
	float z_ndc = (mvpMtx * vec4(mm.xyz, 1.0)).z;
	return (z_ndc + 1.0) / 2.0;
	
}
void main() {
	fColor = vec4(0.0,0.0,0.0,0.0);
	//fColor = vec4(vColor.rgb, 1.0); return;
	vec3 start = vColor;
	gl_FragDepth = 0.0;
	vec3 backPosition = GetBackPosition(start);
	// fColor = vec4(backPosition, 1.0); return;
	vec3 dir = backPosition - start;
	float len = length(dir);
	float lenVox = length((texVox * start) - (texVox * backPosition));
	if ((lenVox < 0.5) || (len > 3.0)) { //length limit for parallel rays
		return;
	}
	float sliceSize = len / lenVox; //e.g. if ray length is 1.0 and traverses 50 voxels, each voxel is 0.02 in unit cube
	float stepSize = sliceSize; //quality: larger step is faster traversal, but fewer samples
	float opacityCorrection = stepSize/sliceSize;
	dir = normalize(dir);
	vec4 deltaDir = vec4(dir.xyz * stepSize, stepSize);
	vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	float lenNoClip = len;
	bool isClip = false;
	vec4 clipPos = applyClip(dir, samplePos, len, isClip);
	//if ((clipPos.a != samplePos.a) && (len < 3.0)) {
	//start: OPTIONAL fast pass: rapid traversal until first hit
	float stepSizeFast = sliceSize * 1.9;
	vec4 deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(volume, samplePos.xyz).a;
		if (val > 0.01) break;
		samplePos += deltaDirFast; //advance ray position
	}
	if ((samplePos.a >= len) && ((overlays < 1.0) || (backgroundMasksOverlays > 0))) {
		if (isClip)
			fColor += clipPlaneColor;
		return;
	}
	fColor = vec4(1.0, 1.0, 1.0, 1.0);
	//gl_FragDepth = frac2ndc(samplePos.xyz); //crude due to fast pass resolution
	samplePos -= deltaDirFast;
	if (samplePos.a < 0.0)
		vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	//end: fast pass
	vec4 colAcc = vec4(0.0,0.0,0.0,0.0);
	vec4 firstHit = vec4(0.0,0.0,0.0,2.0 * lenNoClip);
	const float earlyTermination = 0.95;
	float backNearest = len; //assume no hit
	float ran = fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
	samplePos += deltaDir * ran; //jitter ray
	while (samplePos.a <= len) {
		vec4 colorSample = texture(volume, samplePos.xyz);
		samplePos += deltaDir; //advance ray position
		if (colorSample.a < 0.01) continue;
		if (firstHit.a > lenNoClip)
			firstHit = samplePos;
		backNearest = min(backNearest, samplePos.a);
		colorSample.a = 1.0-pow((1.0 - colorSample.a), opacityCorrection);
		colorSample.rgb *= colorSample.a;
		colAcc= (1.0 - colAcc.a) * colorSample + colAcc;
		if ( colAcc.a > earlyTermination )
			break;
	}
	if (firstHit.a < len)
		gl_FragDepth = frac2ndc(firstHit.xyz);
	colAcc.a = (colAcc.a / earlyTermination) * backOpacity;
	fColor = colAcc;
	if (isClip) //CR
		fColor.rgb = mix(fColor.rgb, clipPlaneColor.rgb, clipPlaneColor.a * 0.15);
	if (overlays < 1.0) return;
	//overlay pass
	len = lenNoClip;
	samplePos = vec4(start.xyz, 0.0); //ray position
	//start: OPTIONAL fast pass: rapid traversal until first hit
	stepSizeFast = sliceSize * 1.9;
	deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(overlay, samplePos.xyz).a;
		if (val > 0.01) break;
		samplePos += deltaDirFast; //advance ray position
	}
	if (samplePos.a >= len) {
		if (isClip && (fColor.a == 0.0))
			fColor += clipPlaneColor;
		return;
	}
	samplePos -= deltaDirFast;
	if (samplePos.a < 0.0)
		vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	//end: fast pass
	float overFarthest = len;
	colAcc = vec4(0.0, 0.0, 0.0, 0.0);
	samplePos += deltaDir * ran; //jitter ray
	vec4 overFirstHit = vec4(0.0,0.0,0.0,2.0 * len);
	if (backgroundMasksOverlays > 0)
		samplePos = firstHit;
	while (samplePos.a <= len) {
		vec4 colorSample = texture(overlay, samplePos.xyz);
		samplePos += deltaDir; //advance ray position
		if (colorSample.a < 0.01) continue;
		if (overFirstHit.a > len)
			overFirstHit = samplePos;
		colorSample.a = 1.0-pow((1.0 - colorSample.a), opacityCorrection);
		colorSample.rgb *= colorSample.a;
		colAcc= (1.0 - colAcc.a) * colorSample + colAcc;
		overFarthest = samplePos.a;
		if ( colAcc.a > earlyTermination )
			break;
	}
	if (samplePos.a >= len) {
		if (isClip && (fColor.a == 0.0))
			fColor += clipPlaneColor;
		return;
	}
	//if (overFirstHit.a < len)
		gl_FragDepth = frac2ndc(overFirstHit.xyz);
	float overMix = colAcc.a;
	float overlayDepth = 0.3;
	if (fColor.a <= 0.0)
			overMix = 1.0;
	else if (((overFarthest) > backNearest)) {
		float dx = (overFarthest - backNearest)/1.73;
		dx = fColor.a * pow(dx, overlayDepth);
		overMix *= 1.0 - dx;
	}
	fColor.rgb = mix(fColor.rgb, colAcc.rgb, overMix);
	fColor.a = max(fColor.a, colAcc.a);
}`;

export var vertSliceShader = `#version 300 es
#line 150
layout(location=0) in vec3 pos;
uniform int axCorSag;
uniform float slice;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopWidthHeight;
out vec3 texPos;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	vec2 frac;
	frac.x = (leftTopWidthHeight.x + (pos.x * leftTopWidthHeight.z)) / canvasWidthHeight.x; //0..1
	frac.y = 1.0 - ((leftTopWidthHeight.y + ((1.0 - pos.y) * leftTopWidthHeight.w)) / canvasWidthHeight.y); //1..0
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
	if (axCorSag == 1)
		texPos = vec3(pos.x, slice, pos.y);
	else if (axCorSag == 2)
		texPos = vec3(slice, pos.x, pos.y);
	else
		texPos = vec3(pos.xy, slice);
}`;

export var fragSliceShader = `#version 300 es
#line 228
precision highp int;
precision highp float;
uniform highp sampler3D volume, overlay;
uniform int backgroundMasksOverlays;
uniform float overlays;
uniform float opacity;
uniform float drawOpacity;
uniform highp sampler3D drawing;
in vec3 texPos;
out vec4 color;
void main() {
	vec4 background = texture(volume, texPos);
	color = vec4(background.rgb, opacity);
	vec4 ocolor = vec4(0.0);
	if (overlays > 0.0) {
		ocolor = texture(overlay, texPos);
	}
	float draw = texture(drawing, texPos).r;
	if (draw > 0.0) {
		vec3 dcolor = vec3(0.0, 0.0, 0.0);
		if (draw >= (3.0/255.0))
			dcolor.b = 1.0;
		else if (draw >= (2.0/255.0))
			dcolor.g = 1.0;
		else
			dcolor.r = 1.0;
		color.rgb = mix(color.rgb, dcolor, drawOpacity);
		color.a = max(drawOpacity, color.a);
	}
	if ((backgroundMasksOverlays > 0) && (background.a == 0.0))
		return;
	float aout = ocolor.a + (1.0 - ocolor.a) * color.a;
	if (aout <= 0.0) return;
	//color.rgb = ((ocolor.rgb * ocolor.a) + (color.rgb * color.a * (1.0 - ocolor.a))) / aout;
	color.rgb = mix(color.rgb, ocolor.rgb, ocolor.a);
	color.a = aout;
}`;

export var fragLineShader = `#version 300 es
#line 189
precision highp int;
precision highp float;
uniform vec4 lineColor;
out vec4 color;
void main() {
	color = lineColor;
}`;

export var vertColorbarShader = `#version 300 es
#line 200
layout(location=0) in vec3 pos;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopWidthHeight;
out vec2 vColor;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	vec2 frac;
	frac.x = (leftTopWidthHeight.x + (pos.x * leftTopWidthHeight.z)) / canvasWidthHeight.x; //0..1
	frac.y = 1.0 - ((leftTopWidthHeight.y + ((1.0 - pos.y) * leftTopWidthHeight.w)) / canvasWidthHeight.y); //1..0
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
	vColor = pos.xy;
}`;

export var fragColorbarShader = `#version 300 es
#line 217
precision highp int;
precision highp float;
uniform highp sampler2D colormap;
in vec2 vColor;
out vec4 color;
void main() {
	color = vec4(texture(colormap, vColor).rgb, 1.0);
}`;

export var vertGraphShader = `#version 300 es
#line 229
layout(location=0) in vec3 pos;
uniform float thickness;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopRightBottom;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	float ny =  (leftTopRightBottom.x-leftTopRightBottom.z);
	float nx =  (leftTopRightBottom.y-leftTopRightBottom.w);
	float len = sqrt((nx*nx)+(ny*ny));
	if (len > 0.0) {
		nx = 0.5*thickness*nx/len;
		ny = 0.5*thickness*ny/len;
	}
	vec2 frac;
	if (pos.y < 0.5)
		frac.y = leftTopRightBottom.y;
	else
		frac.y = leftTopRightBottom.w;
	if (pos.x < 0.5) {
		frac.x = leftTopRightBottom.x;
		frac.y = leftTopRightBottom.y;
	} else {
		frac.x = leftTopRightBottom.z;
		frac.y = leftTopRightBottom.w;
	}
	if (pos.y < 0.5) {
		frac.x += nx;
		frac.y -= ny;
	} else {
		frac.x -= nx;
		frac.y += ny;
	}
	frac.x /= canvasWidthHeight.x;
	frac.y = 1.0 - (frac.y / canvasWidthHeight.y);
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
}`;

export var vertLineShader = `#version 300 es
#line 229
layout(location=0) in vec3 pos;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopWidthHeight;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	vec2 frac;
	frac.x = (leftTopWidthHeight.x + (pos.x * leftTopWidthHeight.z)) / canvasWidthHeight.x; //0..1
	frac.y = 1.0 - ((leftTopWidthHeight.y + ((1.0 - pos.y) * leftTopWidthHeight.w)) / canvasWidthHeight.y); //1..0
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
}`;

export var vertBmpShader = `#version 300 es
#line 229
layout(location=0) in vec3 pos;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopWidthHeight;
out vec2 vUV;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	vec2 frac;
	frac.x = (leftTopWidthHeight.x + (pos.x * leftTopWidthHeight.z)) / canvasWidthHeight.x; //0..1
	frac.y = 1.0 - ((leftTopWidthHeight.y + ((1.0 - pos.y) * leftTopWidthHeight.w)) / canvasWidthHeight.y); //1..0
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
	vUV = vec2(pos.x, 1.0 - pos.y);
}`;

export var fragBmpShader = `#version 300 es
#line 262
precision highp int;
precision highp float;
uniform highp sampler2D bmpTexture;
in vec2 vUV;
out vec4 color;
void main() {
	color = texture(bmpTexture, vUV);
}`;

export var vertFontShader = `#version 300 es
#line 244
layout(location=0) in vec3 pos;
uniform vec2 canvasWidthHeight;
uniform vec4 leftTopWidthHeight;
uniform vec4 uvLeftTopWidthHeight;
out vec2 vUV;
void main(void) {
	//convert pixel x,y space 1..canvasWidth,1..canvasHeight to WebGL 1..-1,-1..1
	vec2 frac;
	frac.x = (leftTopWidthHeight.x + (pos.x * leftTopWidthHeight.z)) / canvasWidthHeight.x; //0..1
	frac.y = 1.0 - ((leftTopWidthHeight.y + ((1.0 - pos.y) * leftTopWidthHeight.w)) / canvasWidthHeight.y); //1..0
	frac = (frac * 2.0) - 1.0;
	gl_Position = vec4(frac, 0.0, 1.0);
	vUV = vec2(uvLeftTopWidthHeight.x + (pos.x * uvLeftTopWidthHeight.z), uvLeftTopWidthHeight.y  + ((1.0 - pos.y) * uvLeftTopWidthHeight.w) );
}`;

export var fragFontShader = `#version 300 es
#line 262
precision highp int;
precision highp float;
uniform highp sampler2D fontTexture;
uniform vec4 fontColor;
uniform float screenPxRange;
in vec2 vUV;
out vec4 color;
float median(float r, float g, float b) {
    return max(min(r, g), min(max(r, g), b));
}
void main() {
	vec3 msd = texture(fontTexture, vUV).rgb;
	float sd = median(msd.r, msd.g, msd.b);
    float screenPxDistance = screenPxRange*(sd - 0.5);
    float opacity = clamp(screenPxDistance + 0.5, 0.0, 1.0);
	color = vec4(fontColor.rgb , fontColor.a * opacity);
}`;

export var vertOrientShader = `#version 300 es
#line 283
precision highp int;
precision highp float;
in vec3 vPos;
out vec2 TexCoord;
void main() {
    TexCoord = vPos.xy;
    gl_Position = vec4( (vPos.xy-vec2(0.5,0.5)) * 2.0, 0.0, 1.0);
}`;

export var fragOrientShaderU = `#version 300 es
uniform highp usampler3D intensityVol;
`;

export var fragOrientShaderI = `#version 300 es
uniform highp isampler3D intensityVol;
`;

export var fragOrientShaderF = `#version 300 es
uniform highp sampler3D intensityVol;
`;

//uniform vec2 canvasWidthHeight;
export var fragOrientShaderAtlas = `#line 309
precision highp int;
precision highp float;
in vec2 TexCoord;
out vec4 FragColor;
uniform float coordZ;
uniform float layer;
uniform float numLayers;
uniform highp sampler2D colormap;
uniform lowp sampler3D blend3D;
uniform float opacity;
uniform vec3 xyzFrac;
uniform mat4 mtx;
void main(void) {
 vec4 vx = vec4(TexCoord.x, TexCoord.y, coordZ, 1.0) * mtx;
 uint idx = texture(intensityVol, vx.xyz).r;
 FragColor = vec4(0.0, 0.0, 0.0, 0.0);
 if (idx == uint(0))
   return;
 if (xyzFrac.x > 0.0) { //outline
   vx = vec4(TexCoord.x+xyzFrac.x, TexCoord.y, coordZ, 1.0) * mtx;
   uint R = texture(intensityVol, vx.xyz).r;
   vx = vec4(TexCoord.x-xyzFrac.x, TexCoord.y, coordZ, 1.0) * mtx;
   uint L = texture(intensityVol, vx.xyz).r;
   vx = vec4(TexCoord.x, TexCoord.y+xyzFrac.y, coordZ, 1.0) * mtx;
   uint A = texture(intensityVol, vx.xyz).r;
   vx = vec4(TexCoord.x, TexCoord.y-xyzFrac.y, coordZ, 1.0) * mtx;
   uint P = texture(intensityVol, vx.xyz).r;
   vx = vec4(TexCoord.x, TexCoord.y, coordZ+xyzFrac.z, 1.0) * mtx;
   uint S = texture(intensityVol, vx.xyz).r;
   vx = vec4(TexCoord.x, TexCoord.y, coordZ-xyzFrac.z, 1.0) * mtx;
   uint I = texture(intensityVol, vx.xyz).r;
   if ((idx == R) && (idx == L) && (idx == A) && (idx == P) && (idx == S) && (idx == I))
     return;
 }
 idx = ((idx - uint(1)) % uint(100))+uint(1);
 float fx = (float(idx)+0.5) / 256.0;
 float y = (2.0 * layer + 1.0)/(2.0 * numLayers);
 FragColor = texture(colormap, vec2(fx, y)).rgba;
 FragColor.a *= opacity;
 if (layer < 2.0) return;
 vec2 texXY = TexCoord.xy*0.5 +vec2(0.5,0.5);
 vec4 prevColor = texture(blend3D, vec3(texXY, coordZ));
 // https://en.wikipedia.org/wiki/Alpha_compositing
 float aout = FragColor.a + (1.0 - FragColor.a) * prevColor.a;
 if (aout <= 0.0) return;
 FragColor.rgb = ((FragColor.rgb * FragColor.a) + (prevColor.rgb * prevColor.a * (1.0 - FragColor.a))) / aout;
 FragColor.a = aout;
}`;

export var fragOrientShader = `#line 309
precision highp int;
precision highp float;
in vec2 TexCoord;
out vec4 FragColor;
uniform float coordZ;
uniform float layer;
uniform float numLayers;
uniform float scl_slope;
uniform float scl_inter;
uniform float cal_max;
uniform float cal_min;
uniform highp sampler2D colormap;
uniform lowp sampler3D blend3D;
uniform float opacity;
uniform mat4 mtx;
void main(void) {
 vec4 vx = vec4(TexCoord.xy, coordZ, 1.0) * mtx;
 float f = (scl_slope * float(texture(intensityVol, vx.xyz).r)) + scl_inter;
 float r = max(0.00001, abs(cal_max - cal_min));
 float mn = min(cal_min, cal_max);
 f = mix(0.0, 1.0, (f - mn) / r);
 //float y = 1.0 / numLayers;
 //y = ((layer + 0.5) * y);
 //https://stackoverflow.com/questions/5879403/opengl-texture-coordinates-in-pixel-space
 float y = (2.0 * layer + 1.0)/(2.0 * numLayers);
 FragColor = texture(colormap, vec2(f, y)).rgba;
 if (layer > 0.7)
   FragColor.a = step(0.00001, FragColor.a);
 FragColor.a *= opacity;
 if (layer < 1.0) return;
 vec2 texXY = TexCoord.xy*0.5 +vec2(0.5,0.5);
 vec4 prevColor = texture(blend3D, vec3(texXY, coordZ));
 // https://en.wikipedia.org/wiki/Alpha_compositing
 float aout = FragColor.a + (1.0 - FragColor.a) * prevColor.a;
 if (aout <= 0.0) return;
 FragColor.rgb = ((FragColor.rgb * FragColor.a) + (prevColor.rgb * prevColor.a * (1.0 - FragColor.a))) / aout;
 FragColor.a = aout;
}`;

export var fragRGBOrientShader = `#line 309
precision highp int;
precision highp float;
in vec2 TexCoord;
out vec4 FragColor;
uniform float coordZ;
uniform float layer;
uniform float numLayers;
uniform float scl_slope;
uniform float scl_inter;
uniform float cal_max;
uniform float cal_min;
uniform highp sampler2D colormap;
uniform lowp sampler3D blend3D;
uniform float opacity;
uniform mat4 mtx;
uniform bool hasAlpha;
void main(void) {
 vec4 vx = vec4(TexCoord.xy, coordZ, 1.0) * mtx;
 uvec4 aColor = texture(intensityVol, vx.xyz);
 FragColor = vec4(float(aColor.r) / 255.0, float(aColor.g) / 255.0, float(aColor.b) / 255.0, float(aColor.a) / 255.0);
 if (!hasAlpha)
   FragColor.a = (FragColor.r * 0.21 + FragColor.g * 0.72 + FragColor.b * 0.07);
 FragColor.a *= opacity;
}`;

export var vertPassThroughShader = `#version 300 es
#line 283
precision highp int;
precision highp float;
in vec3 vPos;
out vec2 TexCoord;
void main() {
    TexCoord = vPos.xy;
    gl_Position = vec4(vPos.x, vPos.y, 0.0, 1.0);
}`;

export var fragPassThroughShader = `#version 300 es
precision highp int;
precision highp float;
in vec2 TexCoord;
out vec4 FragColor;
uniform float coordZ;
uniform lowp sampler3D in3D;
void main(void) {
 FragColor = texture(in3D, vec3(TexCoord.xy, coordZ));
}`;

export var vertSurfaceShader = `#version 300 es
layout(location=0) in vec3 pos;
uniform mat4 mvpMtx;
void main(void) {
	gl_Position = mvpMtx * vec4(pos, 1.0);
}`;

export var fragSurfaceShader = `#version 300 es
precision highp int;
precision highp float;
uniform vec4 surfaceColor;
out vec4 color;
void main() {
	color = surfaceColor;
}`;

export var vertFiberShader = `#version 300 es
layout(location=0) in vec3 pos;
layout(location=1) in vec4 clr;
out vec4 vClr;
uniform mat4 mvpMtx;
void main(void) {
	gl_Position = mvpMtx * vec4(pos, 1.0);
	vClr = clr;
}`;

export var fragFiberShader = `#version 300 es
precision highp int;
precision highp float;
in vec4 vClr;
out vec4 color;
uniform float opacity;
void main() {
	//color = vClr;
	color = vec4(vClr.rgb, opacity);
}`;

export var vertMeshShader = `#version 300 es
layout(location=0) in vec3 pos;
layout(location=1) in vec4 norm;
layout(location=2) in vec4 clr;
uniform mat4 mvpMtx;
uniform mat4 modelMtx;
uniform mat4 normMtx;
out vec4 vClr;
out vec3 vN, vL, vV;
void main(void) {
	vec3 lightPosition = vec3(0.0, 0.0, -10.0);
	gl_Position = mvpMtx * vec4(pos, 1.0);
	vN = normalize((normMtx * vec4(norm.xyz,1.0)).xyz);
	vL = normalize(lightPosition);
	vV = -vec3(modelMtx*vec4(pos,1.0));
	vClr = clr;
}`;

//ToonShader https://prideout.net/blog/old/blog/index.html@tag=toon-shader.html
export var fragMeshToonShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN, vL, vV;
out vec4 color;
float stepmix(float edge0, float edge1, float E, float x){
	float T = clamp(0.5 * (x - edge0 + E) / E, 0.0, 1.0);
	return mix(edge0, edge1, T);
}
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0);
	float ambient = 0.3;
	float diffuse = 0.6;
	float specular = 0.5;
	float shininess = 50.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float df = max(0.0, dot(n, l));
	float sf =  pow(max(dot(reflect(l, n), r), 0.0), shininess);
	const float A = 0.1;
	const float B = 0.3;
	const float C = 0.6;
	const float D = 1.0;
	float E = fwidth(df);
	if (df > A - E && df < A + E) df = stepmix(A, B, E, df);
	else if (df > B - E && df < B + E) df = stepmix(B, C, E, df);
	else if (df > C - E && df < C + E) df = stepmix(C, D, E, df);
	else if (df < A) df = 0.0;
	else if (df < B) df = B;
	else if (df < C) df = C;
	else df = D;
	E = fwidth(sf);
	if (sf > 0.5 - E && sf < 0.5 + E)
		sf = smoothstep(0.5 - E, 0.5 + E, sf);
	else
		sf = step(0.5, sf);
	vec3 a = vClr.rgb * ambient;
	vec3 d = max(df, 0.0) * vClr.rgb * diffuse;
	color.rgb = a + d + (specular * sf);
	color.a = opacity;
}`;

//outline
export var fragMeshOutlineShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN, vL, vV;
out vec4 color;
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.3;
	float diffuse = 0.6;
	float specular = 0.25;
	float shininess = 10.0;
	float PenWidth = 0.6;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = dot(n, l);
	float view = abs(dot(n,r)); //with respect to viewer

	if (PenWidth < view) discard;
	vec3 a = vClr.rgb * ambient;
	vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
	float s =   specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	color.rgb = a + d + s;
	color.a = opacity;
}`;

//Phong: default
export var fragMeshShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN, vL, vV;
out vec4 color;
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.35;
	float diffuse = 0.5;
	float specular = 0.2;
	float shininess = 10.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = dot(n, l);
	vec3 a = vClr.rgb * ambient;
	vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
	float s =   specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	color = vec4(a + d + s, opacity);
}`;

//matte: same as phong without specular and a bit more diffuse
export var fragMeshMatteShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN, vL, vV;
out vec4 color;
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.35;
	float diffuse = 0.6;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = dot(n, l);
	vec3 a = vClr.rgb * ambient;
	vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
	color = vec4(a + d, opacity);
}`;

//Hemispheric
export var fragMeshHemiShader = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN, vL, vV;
out vec4 color;
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.35;
	float diffuse = 0.5;
	float specular = 0.2;
	float shininess = 10.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float lightNormDot = dot(n, l);
	vec3 up = vec3(0.0, 1.0, 0.0);
	float ax = dot(n, up) * 0.5 + 0.5;  //Shreiner et al. (2013) OpenGL Programming Guide, 8th Ed., p 388. ISBN-10: 0321773039
	vec3 upClr = vec3(1.0, 1.0, 0.95);
	vec3 downClr = vec3(0.4, 0.4, 0.6);
	vec3 a = vClr.rgb * ambient;
	a *= mix(downClr, upClr, ax);
	vec3 d = max(lightNormDot, 0.0) * vClr.rgb * diffuse;
	float s =   specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	color = vec4(a + d + s, opacity);
}`;

export var fragMeshShaderSHBlue = `#version 300 es
precision highp int;
precision highp float;
uniform float opacity;
in vec4 vClr;
in vec3 vN, vL, vV;
out vec4 color;
//Spherical harmonics constants
const float C1 = 0.429043;
const float C2 = 0.511664;
const float C3 = 0.743125;
const float C4 = 0.886227;
const float C5 = 0.247708;
//Spherical harmonics coefficients
// Ramamoorthi, R., and P. Hanrahan. 2001b. "An Efficient Representation for Irradiance Environment Maps." In Proceedings of SIGGRAPH 2001, pp. 497–500.
// https://github.com/eskimoblood/processingSketches/blob/master/data/shader/shinyvert.glsl
// https://github.com/eskimoblood/processingSketches/blob/master/data/shader/shinyvert.glsl
// Constants for Eucalyptus Grove lighting
const vec3 L00  = vec3( 0.3783264,  0.4260425,  0.4504587);
const vec3 L1m1 = vec3( 0.2887813,  0.3586803,  0.4147053);
const vec3 L10  = vec3( 0.0379030,  0.0295216,  0.0098567);
const vec3 L11  = vec3(-0.1033028, -0.1031690, -0.0884924);
const vec3 L2m2 = vec3(-0.0621750, -0.0554432, -0.0396779);
const vec3 L2m1 = vec3( 0.0077820, -0.0148312, -0.0471301);
const vec3 L20  = vec3(-0.0935561, -0.1254260, -0.1525629);
const vec3 L21  = vec3(-0.0572703, -0.0502192, -0.0363410);
const vec3 L22  = vec3( 0.0203348, -0.0044201, -0.0452180);
vec3 SH(vec3 vNormal) {
	vNormal = vec3(vNormal.x,vNormal.z,vNormal.y);
	//vNormal = vec3(vNormal.x,vNormal.z,vNormal.y);
	vec3 diffuseColor =  C1 * L22 * (vNormal.x * vNormal.x - vNormal.y * vNormal.y) +
	C3 * L20 * vNormal.z * vNormal.z +
	C4 * L00 -
	C5 * L20 +
	2.0 * C1 * L2m2 * vNormal.x * vNormal.y +
	2.0 * C1 * L21  * vNormal.x * vNormal.z +
	2.0 * C1 * L2m1 * vNormal.y * vNormal.z +
	2.0 * C2 * L11  * vNormal.x +
	2.0 * C2 * L1m1 * vNormal.y +
	2.0 * C2 * L10  * vNormal.z;
	return diffuseColor;
}
void main() {
	vec3 r = vec3(0.0, 0.0, 1.0); //rayDir: for orthographic projections moving in Z direction (no need for normal matrix)
	float ambient = 0.3;
	float diffuse = 0.6;
	float specular = 0.1;
	float shininess = 10.0;
	vec3 n = normalize(vN);
	vec3 lightPosition = vec3(0.0, 10.0, -5.0);
	vec3 l = normalize(lightPosition);
	float s =   specular * pow(max(dot(reflect(l, n), r), 0.0), shininess);
	vec3 a = vClr.rgb * ambient;
	vec3 d = vClr.rgb * diffuse * SH(-reflect(n, vec3(l.x, l.y, -l.z)) );
	color = vec4(a + d + s, opacity);
}`;

export var fragDepthPickingShader = `#version 300 es
precision highp int;
precision highp float;
uniform int id;
in vec3 vColor;
out vec4 color;
void main() {
	color = vec4(vColor, float(id & 255) / 255.0);
}`;

export var fragVolumePickingShader =
  `#version 300 es
#line 506
//precision highp int;
precision highp float;
uniform vec3 rayDir;
uniform vec3 volScale;
uniform vec3 texVox;
uniform vec4 clipPlane;
uniform highp sampler3D volume, overlay;
uniform float overlays;
uniform int id;
in vec3 vColor;
out vec4 fColor;
` +
  kRenderFunc +
  `
void main() {
	vec3 start = vColor;
	fColor = vec4(0.0, 0.0, 0.0, 0.0); //assume no hit: ID = 0
	float fid = float(id & 255)/ 255.0;
	vec3 backPosition = GetBackPosition(start);
	vec3 dir = backPosition - start;
	float len = length(dir);
	float lenVox = length((texVox * start) - (texVox * backPosition));
	if ((lenVox < 0.5) || (len > 3.0)) return;//discard; //length limit for parallel rays
	float sliceSize = len / lenVox; //e.g. if ray length is 1.0 and traverses 50 voxels, each voxel is 0.02 in unit cube
	float stepSize = sliceSize; //quality: larger step is faster traversal, but fewer samples
	float opacityCorrection = stepSize/sliceSize;
	dir = normalize(dir);
	vec4 samplePos = vec4(start.xyz, 0.0); //ray position
	float lenNoClip = len;
	bool isClip = false;
	vec4 clipPos = applyClip(dir, samplePos, len, isClip);
	if (isClip) fColor = vec4(samplePos.xyz, 253.0 / 255.0); //assume no hit: ID = 0
	//start: OPTIONAL fast pass: rapid traversal until first hit
	float stepSizeFast = sliceSize * 1.9;
	vec4 deltaDirFast = vec4(dir.xyz * stepSizeFast, stepSizeFast);
	while (samplePos.a <= len) {
		float val = texture(volume, samplePos.xyz).a;
		if (val > 0.01) {
			fColor = vec4(samplePos.rgb, fid);
			break;
		}
		samplePos += deltaDirFast; //advance ray position
	}
	//end: fast pass
	if (overlays < 1.0) {
		//if (fColor.a == 0.0) discard; //no hit, no overlays
		return; //background hit, no overlays
	}
	//overlay pass
	len = min(lenNoClip, samplePos.a); //only find overlay closer than background
	samplePos = vec4(start.xyz, 0.0); //ray position
	while (samplePos.a <= len) {
		float val = texture(overlay, samplePos.xyz).a;
		if (val > 0.01) {
			fColor = vec4(samplePos.rgb, fid);
			return;
		}
		samplePos += deltaDirFast; //advance ray position
	}
	//if (fColor.a == 0.0) discard; //no hit in either background or overlays
	//you only get here if there is a hit with the background that is closer than any overlay
}`;
