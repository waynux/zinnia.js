(path => {
  class Recognizer {
    constructor(height, width) {
      this.codes = [];
      this.bias;
      this.index = [];
      this.value = [];
    }

    modelLoadFrom(path) {
      const self = this;
      const xhr = new XMLHttpRequest();
      xhr.open("GET", path, true);
      xhr.responseType = "arraybuffer";
      xhr.onload = () => {
        const arrayBuffer = xhr.response;
        const view = new DataView(arrayBuffer);
        const little_endian = (new Int8Array(new Int32Array([1]).buffer)[0] === 1);
        const modelCount = view.getUint32(8,little_endian);
        self.bias = new Float32Array(modelCount);
        const fcc = String.fromCharCode;

        //ignore to parse magic, version
        let offset = 12;
        for(let i = 0 ; i !== modelCount ; ++i) {
          //code
          let raw = new Uint8Array(arrayBuffer, offset, 16);
          if (raw[0] < 128){
            self.codes.push(fcc(raw[0]));
          } else if (raw[0] > 191 && raw[0] < 224) {
            self.codes.push(fcc(((raw[0] & 31) << 6) | ( raw[1] & 63)));
          } else {
            self.codes.push(fcc(((raw[0] & 15) << 12) | (( raw[1] & 63) << 6) | ( raw[2] & 63)));
          }
          offset += 16;

          //bias
          self.bias[i] = view.getFloat32(offset,little_endian);
          offset += 4;

          let index = [];
          let value = [];
          while (true) {
            index.push(view.getUint32(offset,little_endian));
              offset += 4;
            value.push(view.getFloat32(offset,little_endian));
              offset += 4;
            if (index[index.length-1] === 0xFFFFFFFF) {
              index.pop();
              break;
            }
          }
          self.index.push(new Uint32Array(index));
          self.value.push(new Float32Array(value));
        }
        document.getElementById("loader").remove();
      };
      xhr.send();
    }

    classify(character, nbest) {
      const features = this.characterToFeatures(character);
      const results = [];

      const featureDot = (index, value, x2) => {
        let i = 0, j = 0, sum = 0;
        while (i < index.length && j < x2.length) {
          let b = x2[j];
          if (index[i] === b.index) {
            sum += value[i] * b.value;
            ++i;
            ++j;
          } else if (index[i] < b.index) {
            ++i;
          } else {
            ++j;
          }
        }
        return sum;
      };

      const self = this;
      this.codes.forEach((code, i) =>
        results.push({
          bias: self.bias[i] + featureDot(self.index[i], self.value[i], features),
          code
        })
      );

      const insert = (maxlist, item) => {
        for(var i = 0; item.bias < maxlist[i].bias; i++){}
        maxlist.splice(i,0,item);
        maxlist.pop();
      };

      const partialSort = (arr, n) => {
        const maxlist = arr.slice(arr,n).sort((a,b) => (b.bias-a.bias));
        for(let i = n, len = arr.length ; i!=len ; i++){
          if (arr[i].bias > maxlist[n-1].bias) insert(maxlist, arr[i]);
        }
        return maxlist;
      };
      return partialSort(results, nbest);
    }

    characterToFeatures(character){
      const strokeOffsets = character.strokeOffsets;
      let strokes = strokeOffsets.length - 1;
      let nodes = character.nodes;
      if (nodes.length <= 0) throw new Error("Invalid character");
      const features = [{index: 0, value: 1}];  // First Bias term

      const addFeature = (index, value) =>
        features.push({index, value});

      // void Features::makeBasicFeature(int offset, const Node *first, const Node *last)
      const makeBasicFeature = (offset, firstX, firstY, lastX, lastY) => {
        const distance = (x1, y1, x2, y2) => {
          const dx = x1 - x2;
          const dy = y1 - y2;
          return Math.sqrt(dx * dx + dy * dy);
        };

        // distance
        addFeature(offset + 1 , 10 * distance(firstX, firstY, lastX, lastY));

        // degree
        addFeature(offset + 2, Math.atan2(lastY - firstY, lastX - firstX));

        // absolute position
        addFeature(offset + 3, 10 * (firstX - 0.5));
        addFeature(offset + 4, 10 * (firstY - 0.5));
        addFeature(offset + 5, 10 * (lastX - 0.5));
        addFeature(offset + 6, 10 * (lastY - 0.5));

        // absolute degree
        addFeature(offset + 7, Math.atan2(firstY - 0.5, firstX - 0.5));
        addFeature(offset + 8, Math.atan2(lastY - 0.5,  lastX - 0.5));

        // absolute distance
        addFeature(offset + 9,  10 * distance(firstX, firstY, 0.5, 0.5));
        addFeature(offset + 10, 10 * distance(lastX, lastY, 0.5, 0.5));

        // diff
        addFeature(offset + 11, 5 * (lastX - firstX));
        addFeature(offset + 12, 5 * (lastY - firstY));
      };

      // void Features::makeVertexFeature(int sid, std::vector<NodePair> *node_pairs)
      const makeVertexFeature = (nodes, sid, nodePairs) => {
        for (let i = 0, len = nodePairs.length ; i != len && i != 50; ++i) { //i < MAX_CHARACTER_SIZE
          const n = nodePairs[i];
          if (n) makeBasicFeature(sid*1000 + 20*i, nodes[n.firstI], nodes[n.firstI + 1], nodes[n.lastI], nodes[n.lastI + 1]);
        }
      };

      const getVertex = (nodes, firstI, lastI, id, pairs) => {
        pairs[id] = {firstI, lastI};

        if (firstI !== lastI) {
          let a = nodes[lastI] - nodes[firstI];
          let b = nodes[lastI + 1] - nodes[firstI + 1];
          let c = nodes[lastI + 1] * nodes[firstI] - nodes[lastI] * nodes[firstI + 1];

          let max = -1;
          let bestI = null;
          for (let curI = firstI; curI !== lastI; curI += 2) {
            let dist = Math.abs( a*nodes[curI + 1] - b*nodes[curI] + c );
            if (dist > max) {
              max = dist;
              bestI = curI;
            }
          }
          if (max * max / (a * a + b * b) > 0.001) { //minimumDistance > ERROR
            getVertex(nodes, firstI, bestI, id * 2 + 1, pairs);
            getVertex(nodes, bestI, lastI, id * 2 + 2, pairs);
          }
        }
      };

      let prevI;
      for (let i = 0; i != strokes; ++i) {
        let firstI = strokeOffsets[i];
        let lastI = strokeOffsets[i + 1] - 2;
        let nodePairs = [];
        getVertex(nodes, firstI, lastI, 0, nodePairs);
        makeVertexFeature(nodes, i, nodePairs);
        if (i > 0) {
          makeBasicFeature(100000 + i * 1000, nodes[prevI], nodes[prevI + 1], nodes[firstI], nodes[firstI + 1]);
        }
        prevI = lastI;
      }
      addFeature(2000000, strokes);
      addFeature(2000000 + strokes, 10);
      features.sort((a, b) => (a.index - b.index));
      return features;
    }
  }

  const recognizer = new Recognizer();
  recognizer.modelLoadFrom(path);
  const width = 400;
  const height = 400;
  const canvas = document.getElementById('canvas');
  canvas.setAttribute('width', width);
  canvas.setAttribute('height',height);
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = "white";
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.shadowBlur = 10;
  ctx.globalAlpha = 0.7;
  ctx.shadowColor= "#CCCCCC";

  let last;
  let strokeOffsets = [0];
  let nodes = [];
  let click = false;

  const render = cur => {
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(cur.x, cur.y);
    ctx.stroke();
    ctx.closePath();
  };

  const down = cur => {
    click = true;
    nodes.push(cur.x/width, cur.y/height);
    last = cur;
  };

  const move = cur => {
    if (click){
      render(cur);
      nodes.push(cur.x/width, cur.y/height);
      last = cur;
    }
  };

  const up = cur => {
    render(cur);
    nodes.push(cur.x/width, cur.y/height);
    strokeOffsets.push(nodes.length);
    click = false;
    recommend();
  };

  const recommend = () => {
    document.getElementById('suggestions').innerHTML = '';
    recognizer.classify({nodes, strokeOffsets}, 8).forEach(item => {
      const sug = document.createElement('span');
      sug.addEventListener('click', function(e){
        document.getElementById('wordsOut').value += this.innerHTML;
        clear();
      }, false);
      sug.innerHTML = item.code;
      sug.setAttribute('class', 'sugItem');
      document.getElementById('suggestions').appendChild(sug);
    });
  };

  const findxy = (res, e) => {
    if (res === 'downE') down({x:(e.clientX - canvas.offsetLeft), y:(e.clientY - canvas.offsetTop)});
    if (res === 'moveE') move({x:(e.clientX - canvas.offsetLeft), y:(e.clientY - canvas.offsetTop)});
    if (res === 'upE'  )   up({x:(e.clientX - canvas.offsetLeft), y:(e.clientY - canvas.offsetTop)});
  }
  canvas.addEventListener('mousedown', e => findxy('downE',e), false);
  canvas.addEventListener('mousemove', e => findxy('moveE',e), false);
  canvas.addEventListener('mouseup',   e => findxy('upE',  e), false);
  canvas.addEventListener('mouseout',  e => (click = false), false);
  canvas.addEventListener('touchstart', e => findxy('downE', e.targetTouches[0]), false);
  canvas.addEventListener('touchmove', e => findxy('moveE', e.targetTouches[0]), false);
  canvas.addEventListener('touchend',  e => findxy('upE', e.changedTouches[0]), false);
  canvas.addEventListener('touchleave', e => (click = false), false);
  const clear = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokeOffsets = [0];
    nodes = [];
  }
  document.getElementById('clear').addEventListener('click', clear);
  document.getElementById('back').addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if(strokeOffsets[1]){
      strokeOffsets.pop();
      nodes.length = strokeOffsets[strokeOffsets.length-1];
      for(let i=0 ;strokeOffsets[i+1]; i++){
        last = {x:nodes[strokeOffsets[i]]*width, y:nodes[strokeOffsets[i]+1]*height};
        for(let j = strokeOffsets[i]+2; j!= strokeOffsets[i+1]; j+= 2){
          render({x:nodes[j]*width, y:nodes[j+1]*height});
          last = {x:nodes[j]*width, y:nodes[j+1]*height};
        }
      }
      recommend();
    }
  });
  document.getElementById('wordsOut').value = '';
})('handwriting-zh_TW.model');
