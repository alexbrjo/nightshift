/**
 * Sample JavaScript transformation function
 * 
 * This function is applied to each item in the dataset.
 * It receives the current item, its index, and all items as arguments.
 * 
 * @param {Object} item - The current data item
 * @param {number} index - The index of the current item
 * @param {Array} allItems - All items in the dataset
 * @returns {Object} The transformed item
 */

function transform(item, index, allItems) {
  // Example: Add computed fields
  return {
    ...item,
    processed: true,
    processedAt: new Date().toISOString(),
    index: index,
    totalItems: allItems.length,
    
    // Example: Transform existing fields
    title_uppercase: item.title ? item.title.toUpperCase() : null,
    content_length: item.content ? item.content.length : 0,
    
    // Example: Conditional logic
    has_tags: item.tags && item.tags.length > 0,
    tag_count: item.tags ? item.tags.length : 0
  };
}
