<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NButton, NCheckbox, NCheckboxGroup, NModal, NSpace } from "naive-ui";
import { useConfigStore } from "@/stores/config";
import { DEFAULT_ITEM_COLUMNS, ITEM_COLUMNS } from "@/utils/deals";

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ "update:show": [value: boolean] }>();

const config = useConfigStore();
const selected = ref<string[]>([]);

const options = ITEM_COLUMNS.map((c) => ({ label: c.label, value: c.key as string }));
const canSave = computed(() => selected.value.length > 0);

watch(
  () => props.show,
  (v) => {
    if (v) selected.value = [...(config.columns ?? DEFAULT_ITEM_COLUMNS)];
  },
);

function onUpdateShow(v: boolean) {
  emit("update:show", v);
}

function save() {
  config.columns = [...selected.value];
  emit("update:show", false);
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="列设置"
    style="width: 420px"
    @update:show="onUpdateShow"
  >
    <NCheckboxGroup v-model:value="selected">
      <NSpace vertical>
        <NCheckbox v-for="o in options" :key="o.value" :value="o.value" :label="o.label" />
      </NSpace>
    </NCheckboxGroup>
    <template #footer>
      <NSpace justify="end">
        <NButton @click="onUpdateShow(false)">取消</NButton>
        <NButton type="primary" :disabled="!canSave" @click="save">确定</NButton>
      </NSpace>
    </template>
  </NModal>
</template>
