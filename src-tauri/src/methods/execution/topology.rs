use super::*;

pub(crate) fn topological_nodes(
    nodes: &[MethodWorkflowNode],
) -> Result<Vec<MethodWorkflowNode>, String> {
    let all_nodes: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut remaining: HashMap<&str, &MethodWorkflowNode> =
        nodes.iter().filter(|n| n.is_runnable()).map(|n| (n.id.as_str(), n)).collect();
    let mut done = HashSet::new();
    let mut ordered = Vec::new();

    while !remaining.is_empty() {
        let ready_id = remaining
            .values()
            .find(|node| {
                node.depends_on.iter().all(|dep| {
                    all_nodes.get(dep.as_str()).is_some_and(|dep_node| dep_node.is_resource())
                        || done.contains(dep.as_str())
                })
            })
            .map(|node| node.id.clone());
        let Some(id) = ready_id else {
            return Err("method.workflow could not be ordered".into());
        };
        let node = remaining.remove(id.as_str()).expect("ready node exists");
        done.insert(node.id.as_str());
        ordered.push(node.clone());
    }
    Ok(ordered)
}
